'use strict';

var assert = require('assert');
var GithubEvents = require('../githubEvents.js');

var events = new GithubEvents(null, null);

var logger = {
  messages:{
    verbose: [],
    info: [],
    warn: [],
    debug: [],
    silly: []
  },
  logDebug: function(message){
    this.messages.debug.push(message);
  },
  logInfo: function(message){
    this.messages.info.push(message);
  },
  logError: function(message){
    this.messages.info.push(message);
  }
};

describe('githubEvents', function () {
  it('check token rejects on any error', function () {
    var userInfo = {
        accessToken: 'at'
    };

    var request = function(options, callback){
        callback("error, unknown", {statusCode: 500});
    };

    return events.checkToken(userInfo, request, logger)
    .then(function(){
        assert(false, 'error wasnt rejected');
    })
    .catch(function(error){
        assert.equal(error.code, 500);
    });
  });

  it('check token translates 401 from github to 401 on our error', function () {
    var userInfo = {
        accessToken: 'at'
    };

    var request = function(options, callback){
        callback(null, {statusCode: 401});
    };

    return events.checkToken(userInfo, request, logger)
    .then(function(){
        assert(false, 'error wasnt rejected');
    })
    .catch(function(error){
        assert.equal(error.code, 401);
    });
  });

  it('check all other response errors are 500', function () {
    var userInfo = {
        accessToken: 'at'
    };

    var request = function(options, callback){
        // this response code doesn't mean anything, it's just not a 200
        callback(null, {statusCode: 480});
    };

    return events.checkToken(userInfo, request, logger)
    .then(function(){
        assert(false, 'error wasnt rejected');
    })
    .catch(function(error){
        assert.equal(error.code, 500);
    });
  });

  it('check 200 response gives a valid token', function () {
    var userInfo = {
        accessToken: 'at'
    };

    var request = function(options, callback){
        callback(null, {statusCode: 200});
    };

    return events.checkToken(userInfo, request, logger)
    .then(function(){
        assert(true, 'error wasnt rejected');
    })
    .catch(function(){
        assert(false, 'shouldnt get an error');
    });
  });
});


