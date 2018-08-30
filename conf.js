/*jslint node: true */
"use strict";

//exports.port = 6655;
//exports.myUrl = 'wss://mydomain.com/bb';
exports.bServeAsHub = false;
exports.bLight = false;

exports.storage = 'sqlite';

<<<<<<< HEAD
exports.hub = '127.0.0.1:6616';
=======
exports.hub = 'test.mainchain.pow.trustnote.org:9191';
>>>>>>> Update conf.js
exports.deviceName = 'Headless';
exports.permanent_pairing_secret = 'randomstring';
exports.control_addresses = ['DEVICE ALLOWED TO CHAT'];
exports.payout_address = 'WHERE THE MONEY CAN BE SENT TO';
exports.KEYS_FILENAME = 'keys.json';

exports.initialWitnesses = [
    '72FZXZMFPESCMUHUPWTZJ2F57YV32JCI',
    '2G6WV4QQVF75EPKSXTVRKRTZYSXNIWLU',
    '4ZJ3HQTLYK72O4PLE3GA4ZYCYXLIFHXK',
    '7RR5E6BRHE55FHE76HO6RT2E4ZP3CHYA',
    'CAGSFKGJDODHWFJF5LS7577TKVPLH7KG',
    'FX2B6E622RF4J4MM2OUWMGSOKJP7XTXB',
    'JN2N7SOMDKNSDGMVAW346BYTOSKZIIT4',
    'SAHCPBJAAOXRJ6KRSM3OGATIRSWIWOQA',
    'WL44BDM4QNCMAM5AS3ZB2GYTVDBWAS5Z'
];

// where logs are written to (absolute path).  Default is log.txt in app data directory
//exports.LOG_FILENAME = '/dev/null';

// this is for runnining RPC service only, see play/rpc_service.js
exports.rpcInterface = '127.0.0.1';
exports.rpcPort = '6552';

console.log('finished headless conf');
