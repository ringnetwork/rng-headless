/*jslint node: true */
"use strict";
var headlessWallet = require('../start.js');
var conf = require('rng-core/config/conf.js');
var eventBus = require('rng-core/base/event_bus.js');
var db = require('rng-core/db/db.js');
var constants = require('rng-core/config/constants.js');
var objectHash = require("../base/object_hash.js");

function onError(err){
	throw Error(err);
}

function createRewardPayment(rewardPeriod, totalReward){
	var composer = require('rng-core/unit/composer.js');
	var network = require('rng-core/p2p/network.js');
	var callbacks = composer.getSavingCallbacks({
		ifNotEnoughFunds: onError,
		ifError: onError,
		ifOk: function(objJoint){
			network.broadcastJoint(objJoint);
		}
	});

	var from_address = "PYQJWUWRMUUUSUHKNJWFHSR5OADZMUYR";
	var arrOutputs = [
		{address: from_address, amount: 0}      // the change
	];
	var  reward_message = "DepositReward"+rewardPeriod;
	db.query("SELECT address, SUM(coin_reward) AS reward FROM coin_reward WHERE reward_period=? \n\
			 GROUP BY address ORDER BY reward DESC LIMIT ?", 
		[rewardPeriod, constants.DEPOSIT_REWARD_RESTRICTION],
		function(rows){
			if(rows.length === 0)
				return ;
			var totalCoin = 0;
			for(var i=0; i<rows.length; i++){
				totalCoin += rows[i].coinReward;
			}
			for(var i=0; i<rows.length; i++){
				var rewardAddress = rows[i].address;
				var rewardAmount = totalReward * (Math.floor(rows[i].coinReward*10000/totalCoin)/10000);
				arrOutputs.push({address: rewardAddress, amount: rewardAmount});
			}

			var rewardParams = {
				paying_addresses: from_address,
				outputs: arrOutputs,
				signer: headlessWallet.signer,
				callbacks: callbacks,
				messages: [{
					app: "text",
					payload_location: "inline",
					payload_hash: objectHash.getBase64Hash(reward_message),
					payload: objectHash.getBase64Hash(reward_message)
				}]
			};
			composer.composeJoint( rewardParams );
	});
	
}


eventBus.on('round_switch', function(round_index){
	if(!conf.bCalculateReward || !conf.bLight)
		return 
	if(round_index <= constants.DEPOSIT_REWARD_PERIOD)
		return 
	if((round_index-3)%constants.DEPOSIT_REWARD_PERIOD !== 0)
		return 
	var rewardPeriod = depositReward.getRewardPeriod(round_index-3);
	depositReward.getTotalRewardByPeriod(db, rewardPeriod, function(err, totalReward){
		if(err)
			onError(err);
		createRewardPayment(rewardPeriod, totalReward);
	});
	
});
