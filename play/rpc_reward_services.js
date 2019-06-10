/*jslint node: true */

/*
	Accept commands via JSON-RPC API.
	The daemon listens on port 6552 by default.
*/

"use strict";
var headlessWallet = require('../start.js');
var conf = require('rng-core/config/conf.js');
var eventBus = require('rng-core/base/event_bus.js');
var db = require('rng-core/db/db.js');
var mutex = require('rng-core/base/mutex.js');
var storage = require('rng-core/db/storage.js');
var constants = require('rng-core/config/constants.js');
var validationUtils = require("rng-core/validation/validation_utils.js");
var round =  require('rng-core/pow/round.js');
var objectHash = require("rng-core/base/object_hash.js");
var depositReward  = require("rng-core/sc/deposit_reward.js");
var wallet_id;

var last_round_index = 0;
var last_main_chain_index = 0;

var arrRewardedOutputs = [];

var MAX_OUTPUTS = 3;

if (conf.bSingleAddress)
	throw Error('can`t run in single address mode');

function initRPC() {
	var composer = require('rng-core/unit/composer.js');
	var network = require('rng-core/p2p/network.js');

	var rpc = require('json-rpc2');
	var walletDefinedByKeys = require('rng-core/wallet/wallet_defined_by_keys.js');
	var Wallet = require('rng-core/wallet/wallet.js');
	var balances = require('rng-core/wallet/balances.js');

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
	server.expose('getInfo', function(args, opt, cb) {
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
	server.expose('getNewAddress', function(args, opt, cb) {
		mutex.lock(['rpc_getNewAddress'], function(unlock){
			walletDefinedByKeys.issueNextAddress(wallet_id, 0, function(addressInfo) {
				unlock();
				cb(null, addressInfo.address);
			});
		});
	});

	/**
	 * get all wallet address.
	 * @return [String] address
	 */
	server.expose('getAllAddress', function(args, opt, cb) {
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
	server.expose('getBalance', function(args, opt, cb) {
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
				console.log('getBalance took '+(Date.now()-start_time)+'ms');
				cb(null, balances);
			});
	});

	/**
	 * Returns wallet balance(stable and pending) without commissions earned from headers and witnessing.
	 *
	 * @return {"base":{"stable":{Integer},"pending":{Integer}}} balance
	 */
	server.expose('getMainBalance', function(args, opt, cb) {
		let start_time = Date.now();
		balances.readOutputsBalance(wallet_id, function(balances) {
			console.log('getMainBalance took '+(Date.now()-start_time)+'ms');
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
	server.expose('listTransactions', function(args, opt, cb) {
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
				console.log('listTransactions '+JSON.stringify(args)+' took '+(Date.now()-start_time)+'ms');
				cb(null, result);
			});
		}

	});
	
	/**
	 * check address is valid.
	 * @return [string] msg
	 */
	server.expose('checkAddress', function(args, opt, cb) {
		var address = args[0];
		if(address) {
			if(validationUtils.isValidAddress(address)) {
				cb(null, "ok");
			}
			else {
				cb("invalid address");
			}
		}
		else {
			cb("invalid address");
		}
	});

	/**
	 * Send funds to address.
	 * If address is invalid, then returns "invalid address".
	 * @param {String} address
	 * @param {Integer} amount
	 * @return {String} status
	 */
	server.expose('sendToAddress', function(args, opt, cb) {
		console.log('sendToAddress '+JSON.stringify(args));
		let start_time = Date.now();
		var amount = args[1];
		var toAddress = args[0];
		if (amount && toAddress) {
			if (validationUtils.isValidAddress(toAddress))
				headlessWallet.issueChangeAddressAndSendPayment(null, amount, toAddress, null, function(err, unit) {
					console.log('sendToAddress '+JSON.stringify(args)+' took '+(Date.now()-start_time)+'ms');
					cb(err, err ? undefined : unit);
				});
			else
				cb("invalid address");
		}
		else
			cb("wrong parameters");
	});

	server.expose('sendToMultiAddress', function(args, opt, cb) {
		try{
			console.log('sendToMultiAddress '+JSON.stringify(args));
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
		
	server.expose('getTotalRewardByPeriod', function(args, opt, cb) {
		try{
			if(!conf.bCalculateReward || conf.bLight)
				return cb("bCalculateReward is false or bLight is true, cannt send reward payment"); 
			var rewardPeriod = args[0];
			
			depositReward.getTotalRewardByPeriod(db, rewardPeriod, function(err, totalReward){
				if(err)
					onError(err);
				return cb(err,  err ? undefined : totalReward );
			});	
		}
		catch(err)
		{
			console.log("wrong parameters" + err.message);
			cb(err.message);
		}
	});

	// server.expose('getRewardUnitByPeriod', function(args, opt, cb) {
	// 	try{
	// 		if(!conf.bCalculateReward || conf.bLight)
	// 			return cb("bCalculateReward is false or bLight is true, cannt send reward payment"); 
	// 		var rewardPeriod = args[0];
			
	// 		depositReward.getTotalRewardByPeriod(db, rewardPeriod, function(err, totalReward){
	// 			if(err)
	// 				onError(err);
	// 			return cb(err,  err ? undefined : totalReward );
	// 		});	
	// 	}
	// 	catch(err)
	// 	{
	// 		console.log("wrong parameters" + err.message);
	// 		cb(err.message);
	// 	}
	// });

	server.expose('sendRewardPayment', function(args, opt, cb) {
		try{
			if(!conf.bCalculateReward || conf.bLight)
				return cb("bCalculateReward is false or bLight is true, cannt send reward payment"); 
			var rewardPeriod = args[0];
			var reward_message = "DepositReward:"+rewardPeriod;
			var payload_hash = objectHash.getBase64Hash(reward_message);
			db.query(
				"SELECT count(*) AS unitCount FROM messages where payload_hash=?", 
				[payload_hash], 
				function(rows){
					if(rows.length !== 1)
						return cb("error"); 
					if(rows[0].unitCount > 0)
						return cb("this period has been rewarded"); 
					round.getCurrentRoundIndex(null, function(round_index){
						if(round_index <= constants.DEPOSIT_REWARD_PERIOD)
							return cb("the first reward period dont need send reward payment"); 
						if(round_index < rewardPeriod*constants.DEPOSIT_REWARD_PERIOD)
							return cb("cannt send reward payment for the future period");  
						depositReward.getTotalRewardByPeriod(db, rewardPeriod, function(err, totalReward){
							if(err)
								onError(err);
							createRewardPayment(rewardPeriod, totalReward, function(err){
								cb(err, err ? undefined : "succeed!");
							});
						});	
					})
				}
			);
		}
		catch(err)
		{
			console.log("wrong parameters" + err.message);
			cb(err.message);
		}
	});

	headlessWallet.readSingleWallet(function(_wallet_id) {
		wallet_id = _wallet_id;
		// listen creates an HTTP server on localhost only
		server.listen(conf.rpcRewardPort, conf.rpcInterface);
	});
}

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

function createRewardPayment(rewardPeriod, totalReward, cb2){
	function onError(err){
		cb2(err);
	}
	var composer = require('rng-core/unit/composer.js');
	var network = require('rng-core/p2p/network.js');
	var callbacks = composer.getSavingCallbacks({
		ifNotEnoughFunds: onError,
		ifError: onError,
		ifOk: function(objJoint){
			// db.query(
			// 	"INSERT INTO coin_reward_unit (reward_period, address, unit)  \n\
			// 	 VALUES (?, ?, ?)", 
			// 	[rewardPeriod, objJoint.unit.authors[0].address, objJoint.unit.unit], 
			// 	function(){
					// network.broadcastJoint(objJoint);
					// cb2();
			// 	}
			// );
			db.query(
				"UPDATE coin_reward SET is_reward=2 \n\
					WHERE reward_period=? AND address IN (?)", 
				[rewardPeriod, arrRewardedOutputs], 
				function(){
					arrRewardedOutputs = [];
					console.log("AutoRewardPeriod done:" );
					network.broadcastJoint(objJoint);
					createRewardPayment(rewardPeriod, totalReward, cb2);
				}
			);
		}
	});
	headlessWallet.readSingleAddress(function(from_address){
		//var from_address = "HZ5FOM7E76HD3V62RL7URGR7LZOXU4RQ";
		var arrOutputs = [
			{address: from_address, amount: 0}      // the change
		];
		arrRewardedOutputs = [];
		var  reward_message = "DepositReward:"+rewardPeriod;
		db.query("SELECT SUM(coin_reward) AS reward FROM coin_reward WHERE reward_period=? AND coin_reward>0", 
			[rewardPeriod, constants.DEPOSIT_REWARD_RESTRICTION],
			function(rows){
				if(rows.length !== 1)
					return cb2("no reward");
				var totalCoin = rows[0].reward;
				console.log("AutoRewardPeriod totalCoin:" + totalCoin);
				db.query("SELECT address, SUM(coin_reward) AS reward FROM coin_reward WHERE reward_period=? AND coin_reward>0 AND is_reward=0 \n\
						GROUP BY address ORDER BY reward DESC LIMIT ?", 
					[rewardPeriod, constants.DEPOSIT_REWARD_RESTRICTION],
					function(rows){
						if(rows.length === 0)
							return cb2("no reward");
					
						for(var i=0; i<rows.length; i++){
							var rewardAddress = rows[i].address;
							var rewardAmount = totalReward * (Math.floor(rows[i].reward*10000/totalCoin)/10000);
							if(rewardAmount > 0){
								arrRewardedOutputs.push(rewardAddress);
								arrOutputs.push({address: rewardAddress, amount: rewardAmount});
							}
						}

						var rewardParams = {
							paying_addresses: [from_address],
							outputs: arrOutputs,
							signer: headlessWallet.signer,
							callbacks: callbacks,
							messages: [{
								app: "text",
								payload_location: "inline",
								payload_hash: objectHash.getBase64Hash(reward_message),
								payload: reward_message
							}]
						};
						if(arrOutputs.length > 1)
							db.query(
								"UPDATE coin_reward SET is_reward=1 \n\
									WHERE reward_period=? AND address IN (?)", 
								[rewardPeriod, arrRewardedOutputs],  
								function(){
									console.log("AutoRewardPeriod arrRewardedOutputs:" + arrRewardedOutputs);
									composer.composeJoint( rewardParams );
								}
							);
						else
							cb2("no reward required");
				});
			});
	});
}

function onError(err){
	throw Error(err);
}

eventBus.on('updated_last_round_index_from_peers', function (nLastRoundIndexFromPeers, nLastMainChainIndexFromPeers){
    if ( last_round_index < nLastRoundIndexFromPeers )        
    {
        last_round_index = nLastRoundIndexFromPeers;
    }
    if ( last_main_chain_index < nLastMainChainIndexFromPeers )        
    {
        last_main_chain_index = nLastMainChainIndexFromPeers;
    }
})

eventBus.on('round_switch', function(round_index){
	if(!conf.bCalculateReward || !conf.bLight)
		return ;
	if(last_round_index < conf.start_reward_round)  
		return ;	
	if(last_round_index === 0 || last_round_index > round_index )
		return ;
	if(round_index <= constants.DEPOSIT_REWARD_PERIOD)
		return ;
	if((round_index-3)%constants.DEPOSIT_REWARD_PERIOD !== 0)
		return ;
	var rewardPeriod = depositReward.getRewardPeriod(round_index-3);
	console.log("AutoRewardPeriod start:" + rewardPeriod);
	depositReward.getTotalRewardByPeriod(db, rewardPeriod, function(err, totalReward){
		if(err)
			onError(err);
		createRewardPayment(rewardPeriod, totalReward, function(err){
			console.log("AutoRewardPeriod finished:" + rewardPeriod + "," + err ? undefined : "succeed!");
		});
	});	
});


eventBus.on('headless_wallet_ready', initRPC);
