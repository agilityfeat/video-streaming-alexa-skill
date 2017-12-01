'use strict';
const AWS = require('aws-sdk');
const dropboxV2Api = require('dropbox-v2-api');
const util = require('util');
var fs = require('fs');
var request = require("request");
var dropbox_token = process.env['DROPBOX_TOKEN'];
var media_bucket = process.env['MEDIA_BUCKET'];
// var ffmpeg = require('fluent-ffmpeg');

const dropbox = dropboxV2Api.authenticate({
		token: dropbox_token
});

const videoOutput = '/tmp/file.mp4'
const mainOutput = '/tmp/output.mp4'
const dbfile = 'file.mp4'
var maxdata = 1048576000 // default max data limit - this is deliberately set to 1000MB rather than 1 Gig to allow headroom for settings.js transfers plus any other skills running
var datachargerate = 0.090 // this is the AWS Data transfer charge per Gigabyte first 10 TB / month data transfer out beyond the global free tier

process.env['PATH'] = process.env['PATH'] + ':' + process.env['LAMBDA_TASK_ROOT'];

var maxresults = 10;
var partsize = 60*5; // size of the video chunks in seconds
var settings = new Object();
var streamURL;

exports.handler = function(event, context) {
		var player = new alexaplayer(event, context);
		player.handle();
};

var alexaplayer = function (event, context) {
		this.event = event;
		this.context = context;
};

alexaplayer.prototype.handle = function () {
		var requestType = this.event.request.type;
		var userId = this.event.context ? this.event.context.System.user.userId : this.event.session.user.userId;
		console.log('Event:');
		console.log(JSON.stringify(this.event));
		if (this.supportsDisplay()) console.log('Supports display');
		else console.log('Does not support display');

		if (requestType === "LaunchRequest") {
				if (this.supportsDisplay()) {
						var content = {
								"hasDisplaySpeechOutput" : 'Welcome to Dropbox Player. What do you want to play?',
								"hasDisplayRepromptText" : 'Just say what do you want to play or, if you do not know, say ask Dropbox Player to demo',
								"simpleCardTitle" : 'Dropbox Player',
								"simpleCardContent" : 'Listen or watch your favourite videos with less click, click, click and more wow',
								"bodyTemplateTitle" : 'Welcome to Dropbox Player. What do you want to play?',
								"bodyTemplateContent" : 'Just say what do you want to play or, if you do not know, say demo',
								"templateToken" : "dropboxPlayerListTemplate",
								"askOrTell" : ":ask",
								"sessionAttributes": {}
						};
						renderTemplate.call(this, content);
				} else {
						this.speak('Welcome to Dropbox Player. What do you want to listen?', 'Welcome to Dropbox Player', 'Listen or watch your favourite videos with less click, click, click and more wow')
				}

		} else if (requestType === "IntentRequest") {
				var intent = this.event.request.intent;

				if (!process.env['DROPBOX_TOKEN']){
						this.speak('DROPBOX TOKEN Environment Variable not set!');
				}

				if (intent.name === "SearchIntent") {
						var searchFunction = this;
						console.log('Starting Search Intent')

						var alexaUtteranceText = this.event.request.intent.slots.search.value;
						console.log ('Search term is : '+ alexaUtteranceText);

						if (!alexaUtteranceText){
								searchFunction.speak("I'm sorry I didn't understand what you said")
						}
						if (alexaUtteranceText) {
								dropbox({
										resource: 'files/search',
										parameters: {
												"path": "",
												"query": alexaUtteranceText,
												"start": 0,
												"max_results": 20,
												"mode": "filename"
										}
								}, (err, results) => {
										if (err) {
												return console.log(err);
										}

										console.log(JSON.stringify(results));
										console.log('number of results is', results.matches.length);
										if (results.start === 0) searchFunction.speak('I could not find any file with the name ' + alexaUtteranceText + ', lets try again, what do you want to play?', true);
										settings.results = results.matches;
										settings.currentresult = 0;
										settings.previousURL = null;
										settings.previousresult = 0;

										var tracksettings = [];
										var playlist = [];

										for (var count = 0; count <= results.matches.length - 1; count++) {
												playlist[count] = 'Track ' + (count + 1) + ': ' + results.matches[count].metadata.name
												var object = {
														"id": count,
														"title": results.matches[count].metadata.name,
														"path": results.matches[count].metadata.path_display,
														"duration": null,
														"parts": null,
														"size": results.matches[count].metadata.size,
														"currentpart": 0,
														"isVideo": this.validVideoFormat(results.matches[count].metadata.path_display)
												}
												tracksettings.push(object)
										}

										settings.tracksettings = tracksettings;
										settings.playlist = playlist;

										searchFunction.saveSettings(function (err, result) {
												if (err) {
														console.log('There was an error saving settings to dropbox', err)
														searchFunction.speakWithCard('I got an error from the Dropbox API. Check the API Token has been copied into the Lambda environment variable properly, with no extra spaces before or after the Token', 'YOUTUBE DROPBOX ERROR', 'I got an error from the Dropbox API. \nCheck the Token has been copied into the DROPBOX_TOKEN Lambda environment variable properly, with no extra spaces before or after the Token')
												} else {
														searchFunction.loadSettings(function (err, result) {
																if (err) {
																		searchFunction.speak('There was an error loading settings from dropbox')
																} else {
																		searchFunction.processResult(0, null, 0);
																}
														});
												}
										});
								});
						} else {
								searchFunction.speak('I could not find any file with the name ' + alexaUtteranceText + ', What do you want to do?', true);
						}

				} else if (intent.name === "NumberIntent") {

						console.log('Starting number Intent')
						var number = this.event.request.intent.slots.number.value;
						this.numberedTrack(number)


				} else if (intent.name === "AMAZON.StopIntent") {

						console.log('Starting number Intent')
						console.log('Running STOP intent')
						this.stop();

				} else if (intent.name === "AMAZON.PauseIntent") {
						console.log('Running pause intent')
						this.stop();

				} else if (intent.name === "AMAZON.CancelIntent") {
						this.speak(' ');

				} else if (intent.name === "AMAZON.NextIntent") {
						this.next();

				} else if (intent.name === "AMAZON.PreviousIntent") {
						this.previous();

				} else if (intent.name === "AMAZON.ShuffleOffIntent") {
						this.shuffle('off');

				} else if (intent.name === "AMAZON.ShuffleOnIntent") {
						this.shuffle('on');

				} else if (intent.name === "AMAZON.LoopOnIntent") {
						this.loop('on');

				} else if (intent.name === "AMAZON.LoopOffIntent") {
						this.loop('off');

				} else if (intent.name === "AMAZON.RepeatIntent") {
						this.speak('Repeat is not supported by the youtube skill');

				} else if (intent.name === "AMAZON.StartOverIntent") {
						this.numberedTrack(1);

				} else if (intent.name === "AMAZON.HelpIntent") {
						this.help();

				} else if (intent.name === "AMAZON.ResumeIntent") {
						console.log('Resume called');
						var resumefunction = this;
						this.loadSettings(function(err, result)  {
								if (err) {
										resumefunction.speak('There was an error loading settings from dropbox')
								} else {
										var lastPlayed = settings.lastplayed
										var offsetInMilliseconds = 0;
										var token = resumefunction.createToken;
										var results = resumefunction.results;
										var currentresult = settings.currentresult
										var previousresult = settings.previousresult


										var currenturl = settings.currentURL;

										if (lastPlayed !== null) {
												console.log(lastPlayed);
												offsetInMilliseconds = lastPlayed.request.offsetInMilliseconds;
												token = settings.currenttoken;
										}
										if (offsetInMilliseconds < 0){
												offsetInMilliseconds = 0
										}

										if (settings.enqueue == true){
												console.log('RESUME INTENT Track already enqueued')
												settings.enqueue = false
												var tracksettings = settings.tracksettings[currentresult]
												var currentpart = tracksettings.currentpart
												var totalparts = tracksettings.parts
												console.log('RESUME INTENT CurrentResult is', currentresult)
												console.log('RESUME INTENT Currentpart is', currentpart)
												console.log('RESUME INTENT Offset is', offsetInMilliseconds)

												if (currentresult !== previousresult){
														//
														console.log('RESUME INTENT Next track already cued')
														settings.currentresult = previousresult
														currentpart = settings.tracksettings[previousresult].currentpart

														resumefunction.processResult(currentpart, null, offsetInMilliseconds)


												} else {

														// assume we are on the same track so play the previous part
														console.log('RESUME INTENT Next part already cued')
														tracksettings.currentpart--;

														if (tracksettings.currentpart < 0){
																tracksettings.currentpart = 0
														}
														console.log('RESUME INTENT Queueing part ', tracksettings.currentpart)
														settings.tracksettings[currentresult].currentpart = tracksettings.currentpart;
														resumefunction.processResult(tracksettings.currentpart, null,offsetInMilliseconds)
												}

										} else {
												console.log('current URL is ' + currenturl)

												resumefunction.resume(currenturl, offsetInMilliseconds, token);
										}
								}
						});

				} else if (intent.name === "DemoIntent") {
						console.log('Demo intent');
						if (this.supportsDisplay()) {
								dropbox({
										resource: 'files/get_temporary_link',
										parameters: {
												'path': '/Alexa/demo video dropbox player.mp4'
										}
								}, (err, result) => {
										if (err) {
												console.log('There was an error')
												console.log(err)
												this.speak('There was an error playing the demo video');
										} else if (result) {
												console.log('Here is the temp link')
												console.log(result.link)
												var streamURL = result.link
												this.playVideo(streamURL, 0, this.createToken(), "Demo sample video", "Just a streaming video demo");
										}
								});
						} else {
								this.playAudio("https://audio1.maxi80.com/",0,this.createToken(),"Demo sample audio","Just a demo streaming audio from maxi80 radio")
						}
				}

		} else if (requestType === "AudioPlayer.PlaybackStopped") {
				console.log('Playback stopped')
				var playbackstoppedfunction = this;

				this.loadSettings(function(err, result)  {
						if (err) {
								playbackstoppedfunction.speak('There was an error loading settings from dropbox')
						} else {
								settings.lastplayed = playbackstoppedfunction.event
								playbackstoppedfunction.saveSettings(function(err, result)  {
										if (err) {
												console.log('There was an error saving settings to dropbox', err)
										} else {

										}
								});
						}

				});


		}	else if (requestType === "AudioPlayer.PlaybackPause") {
				console.log('Playback paused')

		}	else if (requestType === "AudioPlayer.AudioPlayer.PlaybackFailed") {
				console.log('Playback failed')
				console.log(this.event.request.error.message)

		}	else if (requestType === "AudioPlayer.PlaybackStarted") {
				console.log('Playback started')

				var playbackstartedfunction = this;
				console.log(playbackstartedfunction.event)

				this.loadSettings(function(err, result)  {
						if (err) {
								playbackstartedfunction.speak('There was an error loading settings from dropbox')
						} else {
								settings.lastplayed = playbackstartedfunction.event
								settings.enqueue = false;
								settings.currentlyplaying = playbackstartedfunction.event
								var results = settings.results
								var currentresult = settings.currentresult
								settings.currenttitle = results[currentresult].title

								playbackstartedfunction.saveSettings(function(err, result)  {
										if (err) {
												console.log('There was an error saving settings to dropbox', err)
										} else {

										}
								});
						}

				});

		}	else if (requestType === "AudioPlayer.PlaybackNearlyFinished") {
				console.log('Playback nearly finished')
				var finishedfunction = this;
				var token = this.event.request.token;
				console.log('Token from request is', token)
				// PlaybackNearlyFinished Directive are prone to be delivered multiple times during the same audio being played.
				//If an audio file is already enqueued, exit without enqueuing again.

				this.loadSettings(function(err, result)  {
						if (err) {
								finishedfunction.speak('There was an error loading settings to dropbox')
						} else {

								if (settings.enqueue == true){
										console.log("NEARLY FINISHED Track already enqueued")
								} else {
										console.log("NEARLY FINISHED Nothing already enqueued")
										var results = settings.results
										var current = settings.currentresult

										settings.currenttoken = token
										var tracksettings = settings.tracksettings[current]
										var currentpart = tracksettings.currentpart
										var totalparts = tracksettings.parts
										console.log('NEARLY FINISHED Currentpart is', currentpart)
										console.log('NEARLY FINISHED Total parts ', totalparts)

										if (currentpart <= (totalparts -2)){
												currentpart++
												settings.tracksettings[current].currentpart = currentpart
												console.log('NEARLY FINISHED Queueing part ', currentpart)
												settings.enqueue = true
												finishedfunction.processResult(currentpart, 'enqueue', 0);

										} else {
												console.log('NEARLY FINISHED No parts left - queueing next track')

												settings.previousresult = current
												if (settings.shuffle == 'on'){
														settings.currentresult = Math.floor((Math.random() * (results.length-1) ));
														settings.tracksettings[settings.currentresult].currentpart = 0
														settings.enqueue = true
														finishedfunction.processResult(0, 'enqueue', 0);
												}

												else if (current >= results.length-1){
														if (settings.loop == 'on'){
																settings.currentresult = 0
																settings.tracksettings[settings.currentresult].currentpart = 0
																settings.enqueue = true
																finishedfunction.processResult(0, 'enqueue', 0);
														} else {
																console.log('end of results reached')
														}
												} else if(settings.autoplay == 'off'){
														console.log('Autoplay is off')
												}
												else {
														current++;
														settings.currentresult = current;
														settings.enqueue = true
														finishedfunction.processResult(0, 'enqueue', 0);

												}
										}
								}
						}
				});
		} else if (requestType === "Display.ElementSelected") {
      console.log('Element Selected:');
      console.log(this.event.request.token);
      var id = this.event.request.token.split('_')[1];
      console.log(settings.tracksettings[id]);
      var that = this;
      var getTempURL = function(cb) {
        dropbox({
          resource: 'files/get_temporary_link',
          parameters: {
            'path': settings.tracksettings[id].path
          }
        }, (err, result) => {
          if (err) {
            console.log('There was an error')
            console.log(err)
            this.speak('There was an error playing the demo video');
          } else if (result) {
            console.log('Here is the temp link')
            console.log(result.link)
            var streamURL = result.link
            cb(streamURL);
          }
        });
      };

      if (this.supportsDisplay()) {
        getTempURL( function(streamURL) {
          that.playVideo(streamURL, 0, that.createToken(), settings.tracksettings[id].title, settings.tracksettings[id].size);
        });
      } else {
        getTempURL( function(streamURL) {
          that.playAudio(streamURL, 0, that.createToken(), settings.tracksettings[id].title, "Just streaming audio")
        });
      }
    } else {
		  console.log('unknown request...');
      console.log(this.event.request);
    }

};

alexaplayer.prototype.playAudio = function (mediaURL, offsetInMilliseconds,  tokenValue, title, playlistText) {
		var responseText = 'Playing ' + title;

		var response = {
				version: "1.0",
				response: {
						shouldEndSession: true,
						"outputSpeech": {
								"type": "PlainText",
								"text": responseText,
						},
						"card": {
								"type": "Standard",
								"title": "📺 Playing - " + title + ' 📺',
								"text": playlistText
						},
						directives: [
								{
										type: "AudioPlayer.Play",
										playBehavior: "REPLACE_ALL",
										audioItem: {
												stream: {
														url: mediaURL,
														token: tokenValue,
														expectedPreviousToken: null,
														offsetInMilliseconds: offsetInMilliseconds
												}
										}
								}
						]
				}
		};

		console.log('Play Response is')
		console.log(JSON.stringify(response))
		this.context.succeed(response);
}

alexaplayer.prototype.playVideo = function (mediaURL, offsetInMilliseconds,  tokenValue, title, playlistText) {
  console.log('Play');
		var response = {
				version: "1.0",
				response: {
						outputSpeech: {
								type: "PlainText",
								text: "Playing " + title,
						},
						card: null,
						directives: [
								{
										type: "VideoApp.Launch",
										videoItem:
										{
												source: mediaURL,
												metadata: {
														title: title,
														subtitle: playlistText
												}
										}
								}
						],
						reprompt: null
				}
		};

		console.log('Play Response is')
		console.log(JSON.stringify(response))
		this.context.succeed(response);
};

alexaplayer.prototype.stop = function () {
		console.log("Sending stop response");
		var stopfunction = this;
		settings.lastplayed = this.event;
		this.saveSettings(function(err, result)  {
				if (err) {
						console.log('There was an error saving settings to dropbox', err)
				} else {
						if (!stopfunction.supportsDisplay()) {
								var response = {
										version: "1.0",
										response: {
												shouldEndSession: true,
												directives: [
														{
																type: "AudioPlayer.Stop"
														}
												]
										}
								};
								this.context.succeed(response);
						}
				}
		});
};

alexaplayer.prototype.next = function () {
		console.log("Next function, TBC")

		var filesettings = [];
		var numfunction = this;
		dropbox({
				resource: 'files/list_folder',
				parameters: {
						"path": "/Alexa",
						"recursive": false,
						"include_media_info": false,
						"include_deleted": false,
						"include_has_explicit_shared_members": false,
						"include_mounted_folders": true
				}
		}, (err, results) => {
				if (err) {
						console.log(err);
						numfunction.speak('Something went wrong reading from Dropbox. The Alexa folder might not be present in the linked Dropbox account');
				} else {
						console.log(results);
						console.log('lenght: ' + results.entries.length);
						var playlist=[];
						// Save filenames list
						for (var count = 0; count <= results.entries.length-1; count++) {
								playlist[count] = 'Track ' + (count +1) +': ' + results.entries[count].name
								var object = {
										"id": count,
										"title": results.entries[count].name,
										"path": results.entries[count].path_display,
										"duration": null,
										"parts": null,
										"size": results.entries[count].size,
										"isVideo": this.validVideoFormat(results.entries[count].path_display)
								}
								filesettings.push(object)
						}
						if (number > results.entries.length || number < 1 ){
								numfunction.speak('That is not a valid selection')
						} else {
								var i = 0;
								do {
										if (filesettings[i].isVideo) {
												console.log('Playing ' + filesettings[i].title);
												dropbox({
														resource: 'files/get_temporary_link',
														parameters: {
																'path': filesettings[i].path
														}
												}, (err, result) => {
														if (err) {
																console.log('There was an error')
																console.log(err)
														} else if (result) {
																console.log('Here is the temp link')
																console.log(result.link)
																var streamURL = result.link

																numfunction.playVideo(streamURL, 0, this.createToken, filesettings[i].name, filesettings[i].size)
														}
												});
										} else {
												console.log('File is not a recognized video format, use: m4v,avi or mp4. Playing next');
										}
										i++;
								} while (!filesettings[i].isVideo && i < results.entries.length);
								this.speak('Video file not found in the Alexa Dropbox folder');
						}
				}
		});



};

alexaplayer.prototype.resume = function (audioURL, offsetInMilliseconds, tokenValue) {

		var resumeResponse = {
				version: "1.0",
				response: {
						shouldEndSession: true,

						directives: [
								{
										type: "AudioPlayer.Play",
										playBehavior: "REPLACE_ALL",
										audioItem: {
												stream: {
														url: audioURL,
														streamFormat: "AUDIO_MP4",
														expectedPreviousToken: null,
														offsetInMilliseconds: offsetInMilliseconds,
														//offsetInMilliseconds: 0,
														token: tokenValue
												}
										}
								}
						]
				}
		};
		console.log('Resume Response is')
		console.log(JSON.stringify(resumeResponse))
		this.context.succeed(resumeResponse);
};

alexaplayer.prototype.speak = function (responseText, ask) {
		//console.log('speaking result')
		var session = true
		if (ask){
				session = false
		}
		var response = {
				version: "1.0",
				"sessionAttributes": {},
				response: {
						"outputSpeech": {
								"type": "PlainText",
								"text": responseText,
						},
						"shouldEndSession": session
				}

		};
		this.context.succeed(response);
};

alexaplayer.prototype.speakWithCard = function (responseText, cardTitle, cardText) {
		console.log('speaking with card result')
		var response = {
				version: "1.0",
				"sessionAttributes": {},
				response: {
						"outputSpeech": {
								"type": "PlainText",
								"text": responseText,
						},
						"card": {
								"type": "Standard",
								"title": cardTitle,
								"text": cardText
						},
						"shouldEndSession": true
				}

		};
		this.context.succeed(response);
};

alexaplayer.prototype.numberedTrack = function (number) {
		console.log('Numbered track function')

		var numfunction = this;
		this.loadSettings(function(err, result)  {
				if (err) {
						console.log('There was an error loading settings from dropbox. Starting track 1 in dropbox')
						var filesettings = [];
						dropbox({
								resource: 'files/list_folder',
								parameters: {
										"path": "/Alexa",
										"recursive": false,
										"include_media_info": false,
										"include_deleted": false,
										"include_has_explicit_shared_members": false,
										"include_mounted_folders": true
								}
						}, (err, results) => {
								if (err) {
										console.log(err);
										numfunction.speak('Soemething went wrong reading from Dropbox. The Alexa folder might not be present in the linked Dropbox account');
								} else {
										console.log(results);
										console.log('lenght: ' + results.entries.length);

										// Save filenames list
										for (var count = 0; count <= results.entries.length-1; count++) {
												playlist[count] = 'Track ' + (count +1) +': ' + results[count].name
												var object = {
														"id": count,
														"title": results.entries[count].name,
														"path": results.entries[count].path_display,
														"duration": null,
														"parts": null,
														"size": results.entries[count].size,
														"isVideo": this.validVideoFormat(results.entries[count].path_display)
												}
												filesettings.push(object)
										}

										if (number > results.entries.length || number < 1 ){
												numfunction.speak('That is not a valid selection')
										} else {
												var i = number;
												do {
														if (filesettings[i].isVideo) {
																console.log('Playing ' + filesettings[i].title);
																dropbox({
																		resource: 'files/get_temporary_link',
																		parameters: {
																				'path': filesettings[i].path
																		}
																}, (err, result) => {
																		if (err) {
																				console.log('There was an error')
																				console.log(err)
																		} else if (result) {
																				console.log('Here is the temp link')
																				console.log(result.link)
																				var streamURL = result.link

																				numfunction.playVideo(streamURL, 0, this.createToken, filesettings[i].name, filesettings[i].size)
																		}
																});
														} else {
																console.log('File is not a recognized video format, use: m4v,avi or mp4. Playing next');
														}
														i++;
												} while (!filesettings[i].isVideo && i < results.entries.length)
												this.speak('Video file not found in the Alexa Dropbox folder');
										}
								}
						});

				} else {
						var enqueuestatus = settings.enqueue
						var currenttoken = settings.currenttoken
						var url = settings.currentURL
						var results = settings.playlist
						var current = settings.currentresult
						console.log(JSON.stringify(settings));

						if (number > results.length || number < 1 ){
								numfunction.speak('That is not a valid selection')
						} else {
								settings.currentresult = number-1;
								settings.tracksettings[settings.currentresult].currentpart = 0
								numfunction.processResult(0, null, 0);
						}
				}
		});
};

alexaplayer.prototype.saveSettings = function (callback) {
		// add the writing of this file to the data used (we have to estimate the filesize as being 24KB)
		var wstream = fs.createWriteStream('/tmp/settings.js');
		wstream.write(JSON.stringify(settings));
		wstream.end();
		wstream.on('finish', function () {
				//console.log('seetings file has been written');
				const dropboxUploadlastplayed = dropbox({
						resource: 'files/upload',
						parameters: {
								path: '/Alexa/settings.js',
								mode: 'overwrite',
								mute: true
						}
				}, (err, result) => {
						if (err){
								console.log('There was an error')
								callback(err, null);
						} else if (result){

								callback(null, result);

						}
				});
				fs.createReadStream('/tmp/settings.js').pipe(dropboxUploadlastplayed);
		});



};

alexaplayer.prototype.loadSettings = function (callback) {

		const savefile = fs.createWriteStream('/tmp/settings.js')
		dropbox({
				resource: 'files/download',
				parameters: {
						path: '/Alexa/settings.js'
				}
		}, (err, result) => {
				if (err){
						console.log('There was an error downloading file from dropbox')
						callback(err, null);
				} else if (result){
						//savefile.end();
				}
		}).pipe(savefile);

		savefile.on('finish', function () {
				fs.readFile('/tmp/settings.js', 'utf8', onFileRead);

				function onFileRead(err, data) {
						if (err) {
								console.log('There was an error reading settings file from /tmp')
								callback(err, null);
						} else {
								settings = JSON.parse(data);
								callback(null, {});
						}
				}
		})

};

alexaplayer.prototype.help = function(currentresult) {

		console.log('Help intent');
		var cardtext = '1. Request a particular video: "Alexa, ask Dropbox Player to play Charley bit my finger"\n' +
		'2. Request an auto generated playlist of 25 results: - "Alexa ask Dropbox Player to play SOME David Bowie"\n' +
		'3. Request a particular track from the playlist: "Alexa, ask Dropbox Player to play Track 10"\n' +
		'4. Skip to the next/previous track:- "Alexa, next/ previous track"\n' +
		'5. Pause:- "Alexa pause" or "Alexa stop"\n' +
		'6. Resume playback:- "Alexa resume" ';

		var cardTitle = 'Dropbox Player Skill Commands';

		if (this.supportsDisplay()) {
				this.speakWithCard('Please see the Alexa app for a list of commands that can be used with this skill', cardTitle, cardtext)
		} else {
				this.speak(cardtext);
		}

}

alexaplayer.prototype.processResult = function (partnumber, enqueue, offset) {
		console.log("Processing result");
		if (enqueue) {
				settings.enqueue = true
		}
		if (!offset) {
				offset = 0
		}
		var results = settings.results || settings.playlist;
		var currentresult = settings.currentresult || 0;
		console.log(results);
		console.log(settings);
		console.log(settings.tracksettings[currentresult].path);
		var url = settings.tracksettings[currentresult].path;
		var foundTitle = settings.tracksettings[currentresult].title;
		var processfuntion = this;
		dropbox({
				resource: 'files/get_temporary_link',
				parameters: {
						'path': url
				}
		}, (err, result) => {
				if (err){
						console.log('There was an error')
						console.log(err)
				} else if (result){
						console.log('Here is the temp link')
						console.log(result.link)
						var streamURL = result.link

						if (!enqueue){
								console.log('normal play')
								var token = processfuntion.createToken();
								settings.currenttoken = token
								settings.enqueue = false
								settings.currentURL = streamURL;
								processfuntion.saveSettings(function(err, result)  {
										if (err) {
												console.log('There was an error saving settings to dropbox', err)
												processfuntion.speak('There was an error saving settings to dropbox')
										} else {
												if (processfuntion.supportsDisplay()) processfuntion.playVideo(streamURL, offset, token, foundTitle, "");
										}
								});

						} else {
								console.log('enque play')
								var previoustoken = settings.currenttoken

								var token = processfuntion.createToken();
								settings.currenttoken = token
								settings.enqueue = true

								settings.previousURL = settings.currentURL
								settings.currentURL = streamURL;

								processfuntion.saveSettings(function(err, result)  {
										if (err) {
												console.log('There was an error saving settings to dropbox', err)
												processfuntion.speak('There was an error saving settings to dropbox')
										} else {
												processfuntion.enqueue(streamURL, 0, token, previoustoken);
										}
								});
						}
				}
		});
}


// HELPER FUNCTIONS

alexaplayer.prototype.putObjectToS3 = function(bucket, key, data){
  var s3 = new AWS.S3();
  var params = {
    Bucket : bucket,
    Key : key,
    Body : data
  }
  s3.putObject(params, function(err, data) {
    if (err) console.log(err, err.stack); // an error occurred
    else     console.log(data);           // successful response
  });
}

alexaplayer.prototype.createToken = function() {

		var d = new Date().getTime();
		var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
				var r = (d + Math.random()*16)%16 | 0;
				d = Math.floor(d/16);
				return (c=='x' ? r : (r&0x3|0x8)).toString(16);
		});

		return uuid;
}

alexaplayer.prototype.supportsDisplay = function() {
		var hasDisplay = this.event.context && this.event.context.System &&	this.event.context.System.device &&
		this.event.context.System.device.supportedInterfaces &&	this.event.context.System.device.supportedInterfaces.Display;

		return hasDisplay;
}

alexaplayer.prototype.media_url = function(key) {
		return util.format('https://s3.amazonaws.com/%s/%s', media_bucket, key);
}

alexaplayer.prototype.formatBytes = function(a,b){if(0==a)return"0 Bytes";var c=1024,d=b||2,e=["Bytes","KB","MB","GB","TB","PB","EB","ZB","YB"],f=Math.floor(Math.log(a)/Math.log(c));return parseFloat((a/Math.pow(c,f)).toFixed(d))+" "+e[f]}

alexaplayer.prototype.validVideoFormat = function(filename) {
		var ext = getFileExtension(filename);
		switch (ext.toLowerCase()) {
				case 'm4v':
				case 'avi':
				case 'mpg':
				case 'mp4':
						return true;
		}
		return false;
}

function getFileExtension(filename) {
		var parts = filename.split('.');
		return parts[parts.length - 1];
}

function renderTemplate (content) {
		switch(content.templateToken) {
				case "dropboxPlayerBodyTemplate":
						var response = {
								"version": "1.0",
								"response": {
										"directives": [
												{
														"type": "Display.RenderTemplate",
														"template": {
																"type": "BodyTemplate1",
																"title": content.bodyTemplateTitle,
																"token": content.templateToken,
																"textContent": {
																		"primaryText": {
																				"type": "RichText",
																				"text": "<font size = '5'>"+content.bodyTemplateContent+"</font>"
																		}
																},
																"backButton": "VISIBLE"
														}
												}
										],
										"outputSpeech": {
												"type": "SSML",
												"ssml": "<speak>"+content.hasDisplaySpeechOutput+"</speak>"
										},
										"reprompt": {
												"outputSpeech": {
														"type": "SSML",
														"ssml": "<speak>"+content.hasDisplayRepromptText+"</speak>"
												}
										},
										"shouldEndSession": content.askOrTell==":tell",
										"card": {
												"type": "Simple",
												"title": content.simpleCardTitle,
												"content": content.simpleCardContent
										}
								},
								"sessionAttributes": content.sessionAttributes
						}
						this.context.succeed(response);
						break;

				case "dropboxPlayerListTemplate":

						dropbox({
								resource: 'files/list_folder',
								parameters: {
										"path": "/Alexa",
										"recursive": false,
										"include_media_info": false,
										"include_deleted": false,
										"include_has_explicit_shared_members": false,
										"include_mounted_folders": true
								}
						}, (err, results) => {
								if (err) {
										console.log(err);
										this.speak('Soemething went wrong reading from Dropbox. The Alexa folder might not be present in the linked Dropbox account');
								} else {
										console.log(results);
										console.log('lenght: ' + results.entries.length);

										var tracksettings= [];
										var playlist=[];
										// Save filenames list
										for (var count = 0; count <= results.entries.length-1; count++) {
												playlist[count] = 'Track ' + (count +1) +': ' + results.entries[count].name
												var object = {
														"id": count,
														"title": results.entries[count].name,
														"path": results.entries[count].path_display,
														"duration": null,
														"parts": null,
														"size": results.entries[count].size,
														"isVideo": this.validVideoFormat(results.entries[count].path_display)
												}
												tracksettings.push(object)
										}
										settings.tracksettings = tracksettings;
										settings.playlist = playlist;
										console.log('Saving settings...');
										var renderfunction = this;

										this.saveSettings(function(err, result)  {
												if (err) {
														console.log('There was an error saving settings to dropbox', err)
														renderfunction.speak('I got an error saving the Dropbox file settings')
												} else {

														var listofItems = function() {
                                var list = [];
                                var length = settings.playlist.length - 1;
                                var generatedItems = 0;
                                // Get list with thumbnail icons
                                //for loop each file and generate the view
                                var generateItem = function(seq, cb) {
                                  console.log('Item num:'+seq);
                                  console.log('settings:');
                                  console.log(settings.tracksettings);
                                  var options = {
                                    method: 'POST',
                                    url: 'https://content.dropboxapi.com/2/files/get_thumbnail',
                                    headers:
                                    {
                                      authorization: 'Bearer ' + dropbox_token,
                                      "dropbox-api-arg": '{"path":"'+settings.tracksettings[seq].path+'","format":"jpeg", "size": "w640h480"}'
                                    },
                                    encoding: null
                                  };

                                  request(options, function (error, response, body) {
                                    if (error) {
                                      console.log(err);
                                      this.speak('Something went wrong getting thumbnail from Dropbox');
                                      throw new Error(error);
                                    } else {
                                      console.log(body.toString());
                                      var image = body;
                                      console.log('thumbnail ok above');
                                      fs.writeFile("/tmp/thumbnail"+seq+".jpg", image, function (err) {
                                        if (err) {
                                          console.log("writeFile failed: " + err);
                                        } else {
                                          fs.readFile("/tmp/thumbnail"+seq+".jpg", {encoding: 'base64'}, function (err, data) {
                                            if (err) throw err;
                                            console.log('read file');
                                            console.log(data);
                                            //upload to dropbox thumbnails folder and get url
                                            dropbox({
                                              resource: 'files/upload',
                                              parameters: {
                                                "path": "/AlexaThumbnails/thumbnail"+seq+".jpg",
                                                "mode": "add",
                                                "autorename": true,
                                                "mute": false
                                              },
                                              readStream: fs.createReadStream('/tmp/thumbnail'+seq+'.jpg')
                                            }, (err, results) => {
                                              console.log('after saved tmp and upload')
                                              console.log(results);
                                              console.log(settings);
                                              //get image tmp link
                                              dropbox({
                                                resource: 'files/get_temporary_link',
                                                parameters: {
                                                  'path': '/AlexaThumbnails/thumbnail'+seq+'.jpg'
                                                }
                                              }, (err, result) => {
                                                if (err) {
                                                  console.log('There was an error')
                                                  console.log(err)
                                                  this.speak('There was an error playing the demo video');
                                                } else if (result) {
                                                  console.log('tmp link image:');
                                                  console.log(result.link)
                                                  var obj = {
                                                    "token": "item_" + seq,
                                                    "image": {
                                                      "sources": [
                                                        {
                                                          "url": result.link
                                                        }
                                                      ],
                                                      "contentDescription": "Description"
                                                    },
                                                    "textContent": {
                                                      "primaryText": {
                                                        "type": "RichText",
                                                        // "text": "<action token='play'>"+settings.playlist[seq]+"</action>"
                                                        "text": "<b>"+settings.playlist[seq]+"</b>"
                                                      },
                                                      "secondaryText": {
                                                        "type": "PlainText",
                                                        "text": renderfunction.formatBytes(settings.tracksettings[seq].size)
                                                      }
                                                    }
                                                  }
                                                  list.push(obj);
                                                  console.log('object item ready, seq:'+seq);
                                                  cb();
                                                }
                                              });
                                            });
                                          });
                                        }
                                      });
                                    }
                                  });
                                }

                                return new Promise(function (fulfill, reject) {
                                    for (var i = 0; i < length; i++) {
                                      console.log('for looop num:' + i);
                                      generateItem(i, function () {
                                        generatedItems++;
                                        console.log('generated items:');
                                        console.log(generatedItems);
                                        console.log(length);
                                        if (generatedItems === length) {
                                          console.log('--->List of files:');
                                          console.log(JSON.stringify(list));
                                          fulfill(list);
                                        }
                                      })

                                    }
                                });
                            }

														//console.log(listofItems());
                            listofItems().then(function (res){
                                var response = {
                                    "version": "1.0",
                                    "response": {
                                        "directives": [
                                            {
                                                "type": "Display.RenderTemplate",
                                                "template": {
                                                    "type": "ListTemplate2",
                                                    "token": "list_template_two",
                                                    "title": content.bodyTemplateTitle,
                                                    "backButton": "VISIBLE",
                                                    "listItems": res
                                                }
                                            }
                                        ],
                                        "outputSpeech": {
                                            "type": "SSML",
                                            "ssml": "<speak>"+content.hasDisplaySpeechOutput+"</speak>"
                                        },
                                        "reprompt": {
                                            "outputSpeech": {
                                                "type": "SSML",
                                                "ssml": "<speak>"+content.hasDisplayRepromptText+"</speak>"
                                            }
                                        },
                                        "shouldEndSession": content.askOrTell==":tell",
                                        "card": {
                                            "type": "Simple",
                                            "title": content.simpleCardTitle,
                                            "content": content.simpleCardContent
                                        }
                                    },
                                    "sessionAttributes": content.sessionAttributes
                                }
                                console.log('Whole list response:');
                                console.log(response);
                                renderfunction.context.succeed(response);
                            });
												}
										});
								}
						});
						break;

				default:
						this.response.speak("Thanks for using Dropbox Player, goodbye");
						this.emit(':responseReady');
		}

}