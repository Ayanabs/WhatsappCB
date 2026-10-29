'use strict';

// whatsapp-web.js 1.34.7 can copy a stale __x_id from a media model over
// the outgoing message ID. See wwebjs/whatsapp-web.js#201923.
const fs = require('fs');
const path = require('path');
const pkg = require('whatsapp-web.js/package.json');
if (pkg.version !== '1.34.7') {
  throw new Error(`Review the WhatsApp media patch for whatsapp-web.js ${pkg.version}`);
}
const file = require.resolve('whatsapp-web.js/src/util/Injected/Utils.js');
let source = fs.readFileSync(file, 'utf8');
const marker = '        // Bot\'s won\'t reply if canonicalUrl is set (linking)';
const fix = '        delete message.__x_id; // WhatsApp media ID compatibility fix';
if (!source.includes(fix)) {
  if (!source.includes(marker)) throw new Error('WhatsApp media patch location not found');
  source = source.replace(marker, `${fix}\n\n${marker}`);
}
// Newer WhatsApp Web builds expose the serialized message key as $1.
const lookup = '.Msg.get(newMsgKey._serialized);';
const patchedLookup = '.Msg.get(newMsgKey._serialized || newMsgKey.$1);';
if (!source.includes(patchedLookup)) {
  if (!source.includes(lookup)) throw new Error('WhatsApp message lookup patch location not found');
  source = source.replace(lookup, patchedLookup);
}
fs.writeFileSync(file, source);
