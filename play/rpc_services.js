/*jslint node: true */

/*
	Accept commands via JSON-RPC API.
	The daemon listens on port 6552 by default.
*/

"use strict";
var headlessWallet = require('../start.js');
var conf = require('trustnote-common/conf.js');
var eventBus = require('trustnote-common/event_bus.js');
var db = require('trustnote-common/db.js');
var mutex = require('trustnote-common/mutex.js');
var storage = require('trustnote-common/storage.js');
var constants = require('trustnote-common/constants.js');
var validationUtils = require("trustnote-common/validation_utils.js");
var wallet_id;

if (conf.bSingleAddress)
	throw Error('can`t run in single address mode');

function initRPC() {
	var composer = require('trustnote-common/composer.js');
	var network = require('trustnote-common/network.js');
	var ValidationUtils = require("trustnote-common/validation_utils.js");

	var rpc = require('json-rpc2');
	var walletDefinedByKeys = require('trustnote-common/wallet_defined_by_keys.js');
	var Wallet = require('trustnote-common/wallet.js');
	var balances = require('trustnote-common/balances.js');

	var server = rpc.Server.$create({
		'websocket': true, // is true by default
		'headers': { // allow custom headers is empty by default
			'Access-Control-Allow-Origin': '*'
		}
	});

	/**
	 * Returns information about the current state.
	 * @return { last_mci: {Integer}, last_stable_mci: {Integer}, count_unhandled: {Integer} }
	 */
	server.expose('getinfo', function(args, opt, cb) {
		var response = {};
		storage.readLastMainChainIndex(function(last_mci){
			response.last_mci = last_mci;
			storage.readLastStableMcIndex(db, function(last_stable_mci){
				response.last_stable_mci = last_stable_mci;
				db.query("SELECT COUNT(*) AS count_unhandled FROM unhandled_joints", function(rows){
					response.count_unhandled = rows[0].count_unhandled;
					cb(null, response);
				});
			});
		});
	});

	/**
	 * Creates and returns new wallet address.
	 * @return {String} address
	 */
	server.expose('getnewaddress', function(args, opt, cb) {
		mutex.lock(['rpc_getnewaddress'], function(unlock){
			walletDefinedByKeys.issueNextAddress(wallet_id, 0, function(addressInfo) {
				unlock();
				cb(null, addressInfo.address);
			});
		});
	});

	/**
	 * Creates and returns new wallet address.is_change=1
	 * @return {String} address
	 */
	server.expose('getnewaddress1', function(args, opt, cb) {
		mutex.lock(['rpc_getnewaddress1'], function(unlock){
			walletDefinedByKeys.issueNextAddress(wallet_id, 1, function(addressInfo) {
				unlock();
				cb(null, addressInfo.address);
			});
		});
	});

	/**
	 * get all wallet address.
	 * @return [String] address
	 */
	server.expose('getalladdress', function(args, opt, cb) {
		mutex.lock(['rpc_getalladdress'], function(unlock){
			walletDefinedByKeys.readAllAddressesAndIndex(wallet_id, function(addressList) {
				unlock();
				cb(null, addressList);
			});
		});
	});

	/**
	 * Returns address balance(stable and pending).
	 * If address is invalid, then returns "invalid address".
	 * If your wallet doesn`t own the address, then returns "address not found".
	 * @param {String} address
	 * @return {"base":{"stable":{Integer},"pending":{Integer}}} balance
	 *
	 * If no address supplied, returns wallet balance(stable and pending).
	 * @return {"base":{"stable":{Integer},"pending":{Integer}}} balance
	 */
	server.expose('getbalance', function(args, opt, cb) {
		let start_time = Date.now();
		var address = args[0];
		if (address) {
			if (validationUtils.isValidAddress(address))
				db.query("SELECT COUNT(*) AS count FROM my_addresses WHERE address = ?", [address], function(rows) {
					if (rows[0].count)
						db.query(
							"SELECT asset, is_stable, SUM(amount) AS balance \n\
							FROM outputs JOIN units USING(unit) \n\
							WHERE is_spent=0 AND address=? AND sequence='good' AND asset IS NULL \n\
							GROUP BY is_stable", [address],
							function(rows) {
								var balance = {
									base: {
										stable: 0,
										pending: 0
									}
								};
								for (var i = 0; i < rows.length; i++) {
									var row = rows[i];
									balance.base[row.is_stable ? 'stable' : 'pending'] = row.balance;
								}
								cb(null, balance);
							}
						);
					else
						cb("address not found");
				});
			else
				cb("invalid address");
		}
		else
			Wallet.readBalance(wallet_id, function(balances) {
				console.log('getbalance took '+(Date.now()-start_time)+'ms');
				cb(null, balances);
			});
	});

	/**
	 * Returns wallet balance(stable and pending) without commissions earned from headers and witnessing.
	 *
	 * @return {"base":{"stable":{Integer},"pending":{Integer}}} balance
	 */
	server.expose('getmainbalance', function(args, opt, cb) {
		let start_time = Date.now();
		balances.readOutputsBalance(wallet_id, function(balances) {
			console.log('getmainbalance took '+(Date.now()-start_time)+'ms');
			cb(null, balances);
		});
	});

	/**
	 * Returns transaction list.
	 * If address is invalid, then returns "invalid address".
	 * @param {String} address or {since_mci: {Integer}, unit: {String}}
	 * @return [{"action":{'invalid','received','sent','moved'},"amount":{Integer},"my_address":{String},"arrPayerAddresses":[{String}],"confirmations":{0,1},"unit":{String},"fee":{Integer},"time":{String},"level":{Integer},"asset":{String}}] transactions
	 *
	 * If no address supplied, returns wallet transaction list.
	 * @return [{"action":{'invalid','received','sent','moved'},"amount":{Integer},"my_address":{String},"arrPayerAddresses":[{String}],"confirmations":{0,1},"unit":{String},"fee":{Integer},"time":{String},"level":{Integer},"asset":{String}}] transactions
	 */
	server.expose('listtransactions', function(args, opt, cb) {
		let start_time = Date.now();
		if (Array.isArray(args) && typeof args[0] === 'string') {
			var address = args[0];
			if (validationUtils.isValidAddress(address))
				Wallet.readTransactionHistory({address: address}, function(result) {
					cb(null, result);
				});
			else
				cb("invalid address");
		}
		else{
			var opts = {wallet: wallet_id};
			if (args.unit && validationUtils.isValidBase64(args.unit, constants.HASH_LENGTH))
				opts.unit = args.unit;
			else if (args.since_mci && validationUtils.isNonnegativeInteger(args.since_mci))
				opts.since_mci = args.since_mci;
			else
				opts.limit = 200;
			Wallet.readTransactionHistory(opts, function(result) {
				console.log('listtransactions '+JSON.stringify(args)+' took '+(Date.now()-start_time)+'ms');
				cb(null, result);
			});
		}

	});

	/**
	 * Send funds to address.
	 * If address is invalid, then returns "invalid address".
	 * @param {String} address
	 * @param {Integer} amount
	 * @return {String} status
	 */
	server.expose('sendtoaddress', function(args, opt, cb) {
		console.log('sendtoaddress '+JSON.stringify(args));
		let start_time = Date.now();
		var amount = args[1];
		var toAddress = args[0];
		if (amount && toAddress) {
			if (validationUtils.isValidAddress(toAddress))
				headlessWallet.issueChangeAddressAndSendPayment(null, amount, toAddress, null, function(err, unit) {
					console.log('sendtoaddress '+JSON.stringify(args)+' took '+(Date.now()-start_time)+'ms');
					cb(err, err ? undefined : unit);
				});
			else
				cb("invalid address");
		}
		else
			cb("wrong parameters");
	});


	server.expose('sendtomultiaddress', function(args, opt, cb) {
		try{
			console.log('sendtomultiaddress '+JSON.stringify(args));
			var from_address = args[0];
			var arrAddressesAndAmount = args[1];

			if (from_address && arrAddressesAndAmount) {
				createMultiToAddressPayment(from_address, arrAddressesAndAmount, function(err){
					cb(err, err ? undefined : "succeed!");
				});

			}
			else
				cb("wrong parameters");
		}
		catch(err)
		{
			console.log("wrong parameters" + err.message);
			cb(err.message);
		}
	});

	function createMultiToAddressPayment(from_address, arrAddressesAndAmount, cb1){
		function onError(err){
			cb1(err);
		}
		var callbacks = composer.getSavingCallbacks({
			ifNotEnoughFunds: onError,
			ifError: onError,
			ifOk: function(objJoint){
				network.broadcastJoint(objJoint);
				cb1();
			}
		});

		var arrOutputs = [
			{address: from_address, amount: 0},      // the change
			];
		//{address: "H6JY27IKEDHF6ZWVVIZDXN2YK6TN55AB", amount: 5000000},
		var arrInvalidationAddress = [];
		arrAddressesAndAmount.forEach(function(output){
			if (!ValidationUtils.isValidAddressAnyCase(output.address))
				arrInvalidationAddress.push(output.address);
			arrOutputs.push(output);
		});
		if(arrInvalidationAddress.length > 0)
			throw Error(arrInvalidationAddress);

		composer.composePaymentJoint([from_address], arrOutputs, headlessWallet.signer, callbacks);
	}

	headlessWallet.readSingleWallet(function(_wallet_id) {
		wallet_id = _wallet_id;
		// listen creates an HTTP server on localhost only
		server.listen(conf.rpcPort, conf.rpcInterface);
	});
}

eventBus.on('headless_wallet_ready', initRPC);
