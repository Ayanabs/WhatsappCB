'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const qrcode = require('qrcode-terminal');
const { configPath, encodeBase32, matchingCounter } = require('../core/approvalAuth');

async function main() {
  if (fs.existsSync(configPath)) throw new Error('Approval is already configured; existing credentials were not changed.');
  if (!process.stdin.isTTY) throw new Error('Run setup in an interactive terminal.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));
  async function passwordQuestion(prompt) {
    process.stdout.write(prompt);
    rl._writeToOutput = () => {};
    const value = await question('');
    delete rl._writeToOutput;
    process.stdout.write('\n');
    return value;
  }
  try {
    const password = await passwordQuestion('Choose an approval password (at least 12 characters): ');
    const repeat = await passwordQuestion('Confirm password: ');
    if (password.length < 12 || password.length > 256 || password !== repeat) throw new Error('Passwords do not match or have an invalid length.');
    const secret = crypto.randomBytes(20);
    const encoded = encodeBase32(secret);
    const uri = `otpauth://totp/${encodeURIComponent('Countdown Bot:Approval')}?secret=${encoded}&issuer=${encodeURIComponent('Countdown Bot')}&algorithm=SHA1&digits=6&period=30`;
    console.log('Scan this QR code with an authenticator app, or enter the setup key shown below:');
    qrcode.generate(uri, { small: true });
    console.log(`Setup key: ${encoded}`);
    const code = (await question('Enter the current 6-digit code to finish setup: ')).trim();
    if (matchingCounter(secret, code) === null) throw new Error('Invalid code; setup was not saved.');
    const salt = crypto.randomBytes(16);
    const config = { salt: salt.toString('hex'), passwordHash: crypto.scryptSync(password, salt, 32).toString('hex'), secret: secret.toString('hex') };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
    console.log('Approval enabled. Keep the setup key private.');
  } finally { rl.close(); }
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
