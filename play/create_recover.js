/*jslint node: true */
"use strict";

const fs = require('fs');
const db = require('rng-core/db/db.js');
const eventBus = require('rng-core/base/event_bus.js');
const constants = require('rng-core/config/constants.js');
var objectHash = require('rng-core/base/object_hash.js');
var Mnemonic = require('bitcore-mnemonic');
var ecdsaSig = require('rng-core/encrypt/signature.js');
var validation = require('rng-core/validation/validation.js');
var headlessWallet = require('../start');

var conf = require('rng-core/config/conf.js');
var async = require('async');
var mutex = require('rng-core/base/mutex.js');

var bGenesis = false;

// const witness_budget = 10000000;
// const witness_budget_count = 10;
const genesisConfigFile = "../data/config.json";
// const creation_message = "梦想从这里开始!，Dream begins here!"

var genesisConfigData = {};
var witnesses = [];



var contentb = fs.readFileSync('../data/witnessAddress.json');

witnesses = JSON.parse(contentb);

// for (let address of witnesses) {           // initial the payment arrOutputs
//     for(var i=0; i<witness_budget_count; ++i) {
//         arrOutputs.push({address: address, amount: witness_budget});
//     }
// }

function repeatString(str, times){
    if (str.repeat)
        return str.repeat(times);
    return (new Array(times+1)).join(str);
}


function  runRecover(){
  fs.readFile(genesisConfigFile, 'utf8', function(err, data) {
      if (err){
        console.log("Read genesis input file \"bgenesis.json\" failed: " + err);
        process.exit(0);
      }
      // set global data
      genesisConfigData = JSON.parse(data);
      // console.log("Read genesis input data\n: %s", JSON.stringify(genesisConfigData,null,2) );

      createRecoverUnit(witnesses, function(genesisHash) {
          console.log("\n\n---------->>->> recover trustme unit, hash=" + genesisHash+ "\n\n");

         // setTimeout(createPayment,1000*30);
          //process.exit(0);
          // var placeholders = Array.apply(null, Array(witnesses.length)).map(function(){ return '(?)'; }).join(',');
          // console.log('will insert witnesses', witnesses);
          // var witnesslist = witnesses;
      //     db.query("INSERT INTO my_witnesses (address) VALUES "+placeholders, witnesses, function(){
      //     console.log('inserted witnesses');
      //     setInterval(createPayment,1000*30)
      // });
  });
})
}

function onError(err) {
    throw Error(err);
}

function getConfEntryByAddress(address) {
    for (let item of genesisConfigData) {
        if(item["address"] === address){
            return item;
        }
    }
    console.log(" \n >> Error: witness address "
    + address +" not founded in the \"bgensis.json\" file!!!!\n");
    process.exit(0);
    //return null;
}

function getDerivedKey(mnemonic_phrase, passphrase, account, is_change, address_index) {
    console.log("**************************************************************");
    console.log(mnemonic_phrase);

    var mnemonic = new Mnemonic(mnemonic_phrase);
    var xPrivKey = mnemonic.toHDPrivateKey(passphrase);
    //console.log(">> about to  signature with private key: " + xPrivKey);
    var path = "m/44'/0'/" + account + "'/"+is_change+"/"+address_index;
    var derivedPrivateKey = xPrivKey.derive(path).privateKey;
    // console.log(">> derived key: " + derivedPrivateKey);
    return derivedPrivateKey.bn.toBuffer({size:32});        // return as buffer
}

// signer that uses witeness address
var signer = {
    readSigningPaths: function(conn, address, handleLengthsBySigningPaths){
        handleLengthsBySigningPaths({r: constants.SIG_LENGTH});
    },
    readDefinition: function(conn, address, handleDefinition){
        var conf_entry = getConfEntryByAddress(address);
       // console.log(" \n\n conf_entry is ---> \n" + JSON.stringify(conf_entry,null,2));
        var definition = conf_entry["definition"];
        handleDefinition(null, definition);
    },
    sign: function(objUnsignedUnit, assocPrivatePayloads, address, signing_path, handleSignature){
        var buf_to_sign = objectHash.getUnitHashToSign(objUnsignedUnit);
        var item = getConfEntryByAddress(address);
        var derivedPrivateKey = getDerivedKey(
            item["mnemonic_phrase"],
            item["passphrase"],
            0,
            item["is_change"],
            item["address_index"]
          );
        handleSignature(null, ecdsaSig.sign(buf_to_sign, derivedPrivateKey));
    }
};


function composeRecoverJoint(params){
	// recover modi
	if (!conf.bLight)
		return params.callbacks.ifError("only light wallet can use this method");
	if (conf.bLight && !params.lightProps){
		var network = require('rng-core/p2p/network.js');
		network.requestFromLightVendor(
			'light/get_parents_and_last_ball_and_powcount', 
			{witnesses: ""}, 
			// {}, 
			function(ws, request, response){
				if (response.error)
					return params.callbacks.ifError(response.error);
				if (!response.parent_units || !response.last_stable_mc_ball 
					|| !response.last_stable_mc_ball_unit || typeof response.last_stable_mc_ball_mci !== 'number'
					|| typeof response.round_index !== 'number')
					return params.callbacks.ifError("invalid parents from light vendor");
				params.lightProps = response;
				composeRecoverJoint(params);
			}
		);
		return;
	}
	
	var arrPayingAddresses = params.paying_addresses || [];
	var arrMessages = [];
	
	var arrFromAddresses = arrPayingAddresses.sort();

	var lightProps = params.lightProps;
	var signer = params.signer;
	var callbacks = params.callbacks;
	
	if (conf.bLight && !lightProps)
		throw Error("no parent props for light");
	
	if (arrPayingAddresses.length === 0)
		throw Error("no payers?");
	
	var timestamp = Date.now();
	var datafeed = {timestamp: timestamp};
	var objMessage = {
		app: "data_feed",
		payload_location: "inline",
		payload_hash: objectHash.getBase64Hash(datafeed),
		payload: datafeed
	};
	arrMessages.push(objMessage);

	// var bMultiAuthored = (arrFromAddresses.length > 1);
	var objUnit = {
		version: constants.version, 
		alt: constants.alt,
		//timestamp: Date.now(),
		messages: arrMessages,
		authors: []
	};

	var objJoint = {unit: objUnit};
	
	var last_ball_mci;
	var round_index;
	var assocSigningPaths = {};
	var unlock_callback;
	var conn;
	
	var handleError = function(err){
		//profiler.stop('compose');
		unlock_callback();
		if (typeof err === "object"){
			if (err.error_code === "NOT_ENOUGH_FUNDS")
				return callbacks.ifNotEnoughFunds(err.error);
			throw Error("unknown error code in: "+JSON.stringify(err));
		}
		callbacks.ifError(err);
	};
	
	async.series([
		function(cb){ // lock
			mutex.lock(arrFromAddresses.map(function(from_address){ return 'c-'+from_address; }), function(unlock){
				unlock_callback = unlock;
				cb();
			});
		},
		function(cb){ // start transaction
			db.takeConnectionFromPool(function(new_conn){
				conn = new_conn;
				conn.query("BEGIN", function(){cb();});
			});
		},
		function(cb){ // parent units
			if (bGenesis)
				return cb();
			
			function checkForUnstablePredecessors(){
				conn.query(
					// is_stable=0 condition is redundant given that last_ball_mci is stable
					"SELECT 1 FROM units CROSS JOIN unit_authors USING(unit) \n\
					WHERE  (main_chain_index>? OR main_chain_index IS NULL) AND address IN(?) AND definition_chash IS NOT NULL \n\
					UNION \n\
					SELECT 1 FROM units JOIN address_definition_changes USING(unit) \n\
					WHERE (main_chain_index>? OR main_chain_index IS NULL) AND address IN(?) \n\
					UNION \n\
					SELECT 1 FROM units CROSS JOIN unit_authors USING(unit) \n\
					WHERE (main_chain_index>? OR main_chain_index IS NULL) AND address IN(?) AND sequence!='good'", 
					[last_ball_mci, arrFromAddresses, last_ball_mci, arrFromAddresses, last_ball_mci, arrFromAddresses],
					function(rows){
						if (rows.length > 0)
							return cb("some definition changes or definitions or nonserials are not stable yet");
						cb();
					}
				);
			}
			
			if (conf.bLight){
				objUnit.parent_units = lightProps.parent_units;
				objUnit.last_ball = lightProps.last_stable_mc_ball;
				objUnit.last_ball_unit = lightProps.last_stable_mc_ball_unit;
				last_ball_mci = lightProps.last_stable_mc_ball_mci;
				round_index = lightProps.round_index;
				return checkForUnstablePredecessors();
			}
		},
		function(cb){ // authors
			async.eachSeries(arrFromAddresses, function(from_address, cb2){
				
				function setDefinition(){
					signer.readDefinition(conn, from_address, function(err, arrDefinition){
						if (err)
							return cb2(err);
						objAuthor.definition = arrDefinition;
						cb2();
					});
				}
				
				var objAuthor = {
					address: from_address,
					authentifiers: {}
				};
				signer.readSigningPaths(conn, from_address, function(assocLengthsBySigningPaths){
					var arrSigningPaths = Object.keys(assocLengthsBySigningPaths);
					assocSigningPaths[from_address] = arrSigningPaths;
					for (var j=0; j<arrSigningPaths.length; j++)
						objAuthor.authentifiers[arrSigningPaths[j]] = repeatString("-", assocLengthsBySigningPaths[arrSigningPaths[j]]);
					objUnit.authors.push(objAuthor);
					conn.query(
						"SELECT 1 FROM unit_authors CROSS JOIN units USING(unit) \n\
						WHERE address=? AND is_stable=1 AND sequence='good' AND main_chain_index<=? \n\
						LIMIT 1", 
						[from_address, last_ball_mci], 
						function(rows){
							if (rows.length === 0) // first message from this address
								return setDefinition();
							// try to find last stable change of definition, then check if the definition was already disclosed
							conn.query(
								"SELECT definition \n\
								FROM address_definition_changes CROSS JOIN units USING(unit) LEFT JOIN definitions USING(definition_chash) \n\
								WHERE address=? AND is_stable=1 AND sequence='good' AND main_chain_index<=? \n\
								ORDER BY level DESC LIMIT 1", 
								[from_address, last_ball_mci],
								function(rows){
									if (rows.length === 0) // no definition changes at all
										return cb2();
									var row = rows[0];
									row.definition ? cb2() : setDefinition(); // if definition not found in the db, add it into the json
								}
							);
						}
					);
				});
			}, cb);
		}
	], function(err){
		// we close the transaction and release the connection before signing as multisig signing may take very very long
		// however we still keep c-ADDRESS lock to avoid creating accidental doublespends
		conn.query(err ? "ROLLBACK" : "COMMIT", function(){
			conn.release();
			if (err)
				return handleError(err);
			
			// recover add
			objUnit.round_index = round_index;
			objUnit.pow_type = constants.POW_TYPE_TRUSTME;
			objUnit.hp = last_ball_mci + 1;
			objUnit.phase = 0;
			
			var text_to_sign = objectHash.getUnitHashToSign(objUnit);
			async.each(
				objUnit.authors,
				function(author, cb2){
					var address = author.address;
					async.each( // different keys sign in parallel (if multisig)
						assocSigningPaths[address],
						function(path, cb3){
							if (signer.sign){
								signer.sign(objUnit, {}, address, path, function(err, signature){
									if (err)
										return cb3(err);
									// it can't be accidentally confused with real signature as there are no [ and ] in base64 alphabet
									if (signature === '[refused]')
										return cb3('one of the cosigners refused to sign');
									author.authentifiers[path] = signature;
									cb3();
								});
							}
							else{
								signer.readPrivateKey(address, path, function(err, privKey){
									if (err)
										return cb3(err);
									author.authentifiers[path] = ecdsaSig.sign(text_to_sign, privKey);
									cb3();
								});
							}
						},
						function(err){
							cb2(err);
						}
					);
				},
				function(err){
					if (err)
						return handleError(err);
					objUnit.unit = objectHash.getUnitHash(objUnit);
					if (bGenesis)
						objJoint.ball = objectHash.getBallHash(objUnit.unit);
					console.log(require('util').inspect(objJoint, {depth:null}));
					objJoint.unit.timestamp = Math.round(Date.now()/1000); // light clients need timestamp
					
					callbacks.ifOk(objJoint, {}, unlock_callback);
				}
			);
		});
	});
}

function createRecoverUnit(witnesses, onDone) {
    var composer = require('rng-core/unit/composer.js');
    var network = require('rng-core/p2p/network.js');

    var savingCallbacks = composer.getSavingCallbacks({
        ifNotEnoughFunds: onError,
        ifError: onError,
        ifOk: function(objJoint) {
            network.broadcastJoint(objJoint);
            onDone(objJoint.unit.unit);
        }
    });

    var recoverUnitInput = {
        witnesses: witnesses,
        paying_addresses: witnesses,
        outputs: [],
        signer: signer,
        callbacks: {
            ifNotEnoughFunds: onError,
            ifError: onError,
            ifOk: function(objJoint, assocPrivatePayloads, composer_unlock) {
                savingCallbacks.ifOk(objJoint, assocPrivatePayloads, composer_unlock);
            }
        },
        messages: []
    };
    composeRecoverJoint( recoverUnitInput );
}

eventBus.once('headless_wallet_ready', function() {
    console.log("创建recover单元");
    runRecover();
});

