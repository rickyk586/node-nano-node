const EventEmitter = require('events');
const dgram = require('dgram');

const { blake2bInit, blake2bUpdate, blake2bFinal } = require('./blake2b');
// raiblocks version uses 32-byte secret keys instead of 64-bytes
const nacl = require('./nacl');
const functions = require('./functions');

const IPV4MASK = Buffer.from('00000000000000000000ffff', 'hex');

const MESSAGE_TYPES = [
  'invalid',
  'not_a_type',
  'keepalive',
  'publish',
  'confirm_req',
  'confirm_ack',
  'bulk_pull',
  'bulk_push',
  'frontier_req'
];

const BLOCK_TYPES = {
  send: 0x02,
  receive: 0x03,
  open: 0x04,
  change: 0x05
};

const BLOCK_TYPES_INDEX = [
  'invalid',
  'not_a_block',
  'send',
  'receive',
  'open',
  'change'
];

const REQUIRED_FIELDS = {
  // These are listed in the order that they need to be hashed
  previous: { types: [ BLOCK_TYPES.send, BLOCK_TYPES.receive, BLOCK_TYPES.change ], length: 32 },
  destination: { types: [ BLOCK_TYPES.send ], length: 32 },
  balance: { types: [ BLOCK_TYPES.send ], length: 16 },
  source: { types: [ BLOCK_TYPES.receive, BLOCK_TYPES.open ], length: 32 },
  representative: { types: [ BLOCK_TYPES.open, BLOCK_TYPES.change ], length: 32 },
  account: { types: [ BLOCK_TYPES.open ], length: 32 }
};

class NanoNode extends EventEmitter {
  /*
   @param port Integer random if unspecified
   */
  constructor(port) {
    super();

    this.peers = [ 'rai.raiblocks.net:7075' ];
    this.maxPeers = 200;
    this.client = dgram.createSocket('udp4');

    this.client.on('error', error => {
      this.emit('error', error);
    });

    this.client.on('message', (msg, rinfo) => {
      msg = parseMessage(Buffer.from(msg));

      // Add this responding peer to list
      const peerAddress = rinfo.address + ':' + rinfo.port;
      const peerIndex = this.peers.indexOf(peerAddress);
      if(peerIndex !== -1)
        this.peers.splice(peerIndex, 1);
      this.peers.unshift(peerAddress);
      if(this.peers.length > this.maxPeers)
        this.peers.pop();

      this.emit('message', msg, rinfo);

      switch(msg.type) {
        case 'keepalive':
          // Send keepalive to each peer in message
          msg.body.forEach(address => {
            if(isIpv6(address)) return; // TODO support packets to IPv6 addresses
            const addrParts = parseIp(address);
            this.client.send(renderMessage({type: 'keepalive'}), addrParts.port, addrParts.address);
          });
          break;
        case 'publish':
          this.emit('block', msg.body);
          break;
      }
    });

    this.client.on('listening', () => {
      this.emit('ready');
    });

    this.client.bind(port);
  }
  publish(msg, accountKey, callback) {
    this.peers.forEach(address => {
      const addrParts = parseIp(address);
      const msgBuffer = renderMessage(msg, accountKey);
      this.client.send(msgBuffer, addrParts.port, addrParts.address, error => {
        error && this.emit('error', error);
        callback && callback(error);
      });
    });
  }
}

// Static utility functions
Object.assign(NanoNode, functions);

function isIpv6(ip) {
  return /^\[[A-Fa-f0-9:]+\]:[0-9]+$/.test(ip);
}

/*
 @param msg Object same format as return from parseMessage
 @param accountKey String hex account secret key to sign block (optional)
 */
function renderMessage(msg, accountKey) {
  msg = msg || {};

  const type = MESSAGE_TYPES.indexOf(msg.type);
  if(type === -1)
    throw new Error('invalid_type');

  const header = Buffer.from([
    0x52, // magic number
    !('mainnet' in msg) || msg.mainnet ? 0x43 : 0x41, // 43 for mainnet, 41 for testnet
    'versionMax' in msg ? msg.versionMax : 0x05,
    'versionUsing' in msg ? msg.versionUsing: 0x05,
    'versionMin' in msg ? msg.versionMin : 0x01,
    type,
    0x00, // extensions 16-bits
    0x00 // extensions 16-bits
  ]);

  // Block type is used as extension value for publish messages
  'extensions' in msg && header.writeInt16BE(msg.extensions, 6);

  if(msg.body instanceof Buffer) {
    return Buffer.concat([ header, msg.body ]);
  } else if(msg.body && msg.type === 'publish') {
    if(!('type' in msg.body) || !(msg.body.type in BLOCK_TYPES))
      throw new Error('invalid_block_type');

    // Update extension value in header
    header.writeInt16BE(BLOCK_TYPES_INDEX.indexOf(msg.body.type), 6);

    const fields = Object.keys(REQUIRED_FIELDS).reduce((out, param) => {
      if(REQUIRED_FIELDS[param].types.indexOf(BLOCK_TYPES[msg.body.type]) !== -1) out.push(param);
      return out;
    }, []);
    
    const values = fields.map(field => {
      if(!(field in msg.body))
        throw new Error('missing_field_' + field)

      const value = Buffer.from(msg.body[field], 'hex');
      if(value.length !== REQUIRED_FIELDS[field].length)
        throw new Error('length_mismatch_' + field);

      return value;
    });

    let signature
    if('signature' in msg.body) {
      signature = Buffer.from(msg.body.signature, 'hex');
    } else if(accountKey) {
      const accountKeyBuf = Buffer.from(accountKey, 'hex');
      if(accountKeyBuf.length !== 32)
        throw new Error('length_mismatch_private_key');

      const context = blake2bInit(32, null);
      blake2bUpdate(context, Buffer.concat(values));
      const hash = blake2bFinal(context);

      signature = nacl.sign.detached(hash, accountKeyBuf);
    }
    const work = Buffer.from(msg.body.work, 'hex').reverse();
    if(work.length !== 8)
      throw new Error('length_mismatch_work');

    return Buffer.concat([header].concat(values).concat([signature, work]));
  } else if(msg.type === 'keepalive') {
    // TODO put some peers in the keepalive messages
    return Buffer.concat([header, Buffer.alloc(144)]);
  }
}

function parseIp(buf, offset) {
  if(buf instanceof Buffer) {
    const result = [];
    if(buf.slice(offset, offset+12).equals(IPV4MASK)) {
      // IPv4
      for(var i=offset+12; i<offset+16; i++) {
        result.push(buf[i]);
      }
      return result.join('.') + ':' + buf.readUInt16LE(offset+16);
    } else {
      // IPv6
      for(var i=offset; i<offset+16; i+=2) {
        result.push(buf.readUInt16BE(i).toString(16));
      }
      return '[' + result.join(':')
        .replace(/(^|:)0(:0)*:0(:|$)/, '$1::$3')
        .replace(/:{3,4}/, '::') + ']:' + buf.readUInt16LE(offset+16);
    }
  } else if(typeof buf === 'string') {
    // Parse string into components on second pass
    const portColon = buf.lastIndexOf(':');
    return {
      address: buf.slice(0,portColon),
      port: parseInt(buf.slice(portColon+1, buf.length), 10)
    }
  }
}

function parseMessage(buf) {
  const message = {}
  if(buf[0] !== 0x52)
    throw new Error('magic_number');

  message.mainnet = false;
  if(buf[1] === 0x43)
    message.mainnet = true;
  else if(buf[1] !== 0x41)
    throw new Error('invalid_network');

  message.versionMax = buf[2];
  message.versionUsing = buf[3];
  message.versionMin = buf[4];

  if(buf[5] >= MESSAGE_TYPES.length)
    throw new Error('invalid_type');
  message.type = MESSAGE_TYPES[buf[5]];

  message.extensions = buf.readUInt16BE(6);

  switch(message.type) {
    case 'keepalive':
      // message body contains a list of 8 peers
      const peers = [];
      if(buf.length !== 152)
        throw new Error('invalid_block_length');
      for(let i=8; i<152; i+=18) {
        peers.push(parseIp(buf, i));
      }
      message.body = peers;
      break;
    case 'publish':
      // message body contains a transaction block
      const block = { type: BLOCK_TYPES_INDEX[message.extensions] }
      if(!block.type)
        throw new Error('invalid_block_type');
      const fields = Object.keys(REQUIRED_FIELDS).reduce((out, param) => {
        if(REQUIRED_FIELDS[param].types.indexOf(BLOCK_TYPES[block.type]) !== -1) out.push(param);
        return out;
      }, []);

      let pos=8;
      for(let i=0; i<fields.length; i++) {
        let length = REQUIRED_FIELDS[fields[i]].length;
        block[fields[i]] = buf.slice(pos, pos+length).toString('hex');
        pos += length;
      }
      if(buf.length !== pos+72)
        throw new Error('invalid_block_length');

      const context = blake2bInit(32, null);
      blake2bUpdate(context, buf.slice(8,pos));
      block.hash = Buffer.from(blake2bFinal(context)).toString('hex');

      block.signature = buf.slice(pos, pos+64).toString('hex');
      block.work = buf.slice(pos+64, pos+72).reverse().toString('hex');

      message.body = block;
      break;
    default:
      // no parser defined for this message type
      message.body = buf.slice(8,buf.length);
  }
  return message;
}

module.exports = NanoNode;