
var cookie = require('cookie'),
	express = require('express'),
	util = require('util'),
	async = require('async'),
	fs = require('fs'),
	nconf = require('nconf'),
	winston = require('winston'),

	RedisStoreLib = require('connect-redis')(express),
	RDB = require('./redis'),
	RedisStore = new RedisStoreLib({
		client: RDB,
		ttl: 60 * 60 * 24 * 14
	}),

	user = require('./user'),
	Groups = require('./groups'),
	posts = require('./posts'),
	favourites = require('./favourites'),
	utils = require('../public/src/utils'),
	topics = require('./topics'),
	categories = require('./categories'),
	notifications = require('./notifications'),
	threadTools = require('./threadTools'),
	postTools = require('./postTools'),
	meta = require('./meta'),
	logger = require('./logger'),
	socketCookieParser = express.cookieParser(nconf.get('secret')),
	admin = {
		'categories': require('./admin/categories'),
		'user': require('./admin/user')
	},
	plugins = require('./plugins');


var users = {},
	userSockets = {},
	rooms = {};

module.exports.logoutUser = function(uid) {
	if(userSockets[uid] && userSockets[uid].length) {
		for(var i=0; i< userSockets[uid].length; ++i) {
			userSockets[uid][i].emit('event:disconnect');
			userSockets[uid][i].disconnect();

			if(!userSockets[uid]) {
				return;
			}
		}
	}
}

function isUserOnline(uid) {
	return !!userSockets[uid] && userSockets[uid].length > 0;
}
module.exports.isUserOnline = isUserOnline;

module.exports.init = function(io) {

	global.io = io;

	io.sockets.on('connection', function(socket) {
		var hs = socket.handshake,
			sessionID, uid, lastPostTime = 0;


		// Validate the session, if present
		socketCookieParser(hs, {}, function(err) {
			sessionID = socket.handshake.signedCookies["express.sid"];
			RedisStore.get(sessionID, function(err, sessionData) {
				if (!err && sessionData && sessionData.passport && sessionData.passport.user) uid = users[sessionID] = sessionData.passport.user;
				else uid = users[sessionID] = 0;

				userSockets[uid] = userSockets[uid] || [];
				userSockets[uid].push(socket);

				/* Need to save some state for the logger & maybe some other modules later on */
				socket.state = {
					user : {
						uid : uid
					}
				};

				/* If meta.config.loggerIOStatus > 0, logger.io_one will hook into this socket */
				logger.io_one(socket,uid);

				if (uid) {

					RDB.zadd('users:online', Date.now(), uid, function(err, data) {
						socket.join('uid_' + uid);

						user.getUserField(uid, 'username', function(err, username) {
							socket.emit('event:connect', {
								status: 1,
								username: username,
								uid: uid
							});
						});
					});
				}

				io.sockets. in ('global').emit('api:user.isOnline', isUserOnline(uid));
			});
		});



		socket.on('disconnect', function() {

			var index = userSockets[uid].indexOf(socket);
			if (index !== -1) {
				userSockets[uid].splice(index, 1);
			}

			if (userSockets[uid].length === 0) {
				delete users[sessionID];
				delete userSockets[uid];
				if (uid) {
					RDB.zrem('users:online', uid, function(err, data) {
					});
				}
			}

			io.sockets. in ('global').emit('api:user.isOnline', isUserOnline(uid));

			emitOnlineUserCount();

			for (var roomName in rooms) {

				socket.leave(roomName);

				if (rooms[roomName][socket.id]) {
					delete rooms[roomName][socket.id];
				}

				updateRoomBrowsingText(roomName);
			}
		});

		socket.on('api:get_all_rooms', function(data) {
			socket.emit('api:get_all_rooms', io.sockets.manager.rooms);
		});

		function updateRoomBrowsingText(roomName) {

			function getUidsInRoom(room) {
				var uids = [];
				for (var socketId in room) {
					if (uids.indexOf(room[socketId]) === -1)
						uids.push(room[socketId]);
				}
				return uids;
			}

			function getAnonymousCount(roomName) {
				var clients = io.sockets.clients(roomName);
				var anonCount = 0;

				for (var i = 0; i < clients.length; ++i) {
					var hs = clients[i].handshake;
					if (hs && clients[i].state && clients[i].state.user.uid === 0) {
						++anonCount;
					}
				}
				return anonCount;
			}

			var uids = getUidsInRoom(rooms[roomName]);

			var anonymousCount = getAnonymousCount(roomName);

			if (uids.length === 0) {
				io.sockets. in (roomName).emit('api:get_users_in_room', { users: [], anonymousCount: anonymousCount });
			} else {
				user.getMultipleUserFields(uids, ['uid', 'username', 'userslug', 'picture'], function(err, users) {
					if(!err)
						io.sockets. in (roomName).emit('api:get_users_in_room', { users: users, anonymousCount: anonymousCount });
				});
			}
		}

		socket.on('event:enter_room', function(data) {

			if (data.leave !== null) {
				socket.leave(data.leave);
			}

			socket.join(data.enter);

			rooms[data.enter] = rooms[data.enter] || {};

			if (uid) {
				rooms[data.enter][socket.id] = uid;

				if (data.leave && rooms[data.leave] && rooms[data.leave][socket.id]) {
					delete rooms[data.leave][socket.id];
				}
			}

			if (data.leave)
				updateRoomBrowsingText(data.leave);

			updateRoomBrowsingText(data.enter);

			if (data.enter != 'admin')
				io.sockets. in ('admin').emit('api:get_all_rooms', io.sockets.manager.rooms);

		});

		// BEGIN: API calls (todo: organize)

		socket.on('api:updateHeader', function(data) {
			if (uid) {
				user.getUserFields(uid, data.fields, function(err, fields) {
					if (!err && fields) {
						fields.uid = uid;
						socket.emit('api:updateHeader', fields);
					}
				});
			} else {
				socket.emit('api:updateHeader', {
					uid: 0,
					username: "Anonymous User",
					email: '',
					picture: require('gravatar').url('', {
						s: '24'
					}, https = nconf.get('https'))
				});
			}

		});

		socket.on('user.exists', function(data) {
			if (data.username) {
				user.exists(utils.slugify(data.username), function(exists) {
					socket.emit('user.exists', {
						exists: exists
					});
				});
			}
		});

		socket.on('user.count', function(data) {
			user.count(socket, data);
		});

		socket.on('post.stats', function(data) {
			posts.getTopicPostStats();
		});

		socket.on('user.email.exists', function(data) {
			user.email.exists(socket, data.email);
		});

		socket.on('user:reset.send', function(data) {
			user.reset.send(socket, data.email);
		});

		socket.on('user:reset.valid', function(data) {
			user.reset.validate(socket, data.code);
		});

		socket.on('user:reset.commit', function(data) {
			user.reset.commit(socket, data.code, data.password);
		});

		socket.on('api:user.get_online_users', function(data) {
			var returnData = [];

			for (var i = 0; i < data.length; ++i) {
				var uid = data[i];
				if (isUserOnline(uid))
					returnData.push(uid);
				else
					returnData.push(0);
			}
			socket.emit('api:user.get_online_users', returnData);
		});

		socket.on('api:user.isOnline', function(uid, callback) {
			callback({
				online: isUserOnline(uid),
				uid: uid,
				timestamp: Date.now()
			});
		});

		socket.on('api:user.changePassword', function(data, callback) {
			user.changePassword(uid, data, callback);
		});

		socket.on('api:user.updateProfile', function(data, callback) {
			user.updateProfile(uid, data, callback);
		});

		socket.on('api:user.changePicture', function(data, callback) {

			var type = data.type;

			function updateHeader() {
				user.getUserFields(uid, ['picture'], function(err, fields) {
					if (!err && fields) {
						fields.uid = uid;
						socket.emit('api:updateHeader', fields);
						callback(true);
					} else {
						callback(false);
					}
				});
			}

			if (type === 'gravatar') {
				user.getUserField(uid, 'gravatarpicture', function(err, gravatar) {
					user.setUserField(uid, 'picture', gravatar);
					updateHeader();
				});
			} else if (type === 'uploaded') {
				user.getUserField(uid, 'uploadedpicture', function(err, uploadedpicture) {
					user.setUserField(uid, 'picture', uploadedpicture);
					updateHeader();
				});
			} else {
				callback(false);
			}
		});

		socket.on('api:user.follow', function(data, callback) {
			if (uid) {
				user.follow(uid, data.uid, callback);
			}
		});

		socket.on('api:user.unfollow', function(data, callback) {
			if (uid) {
				user.unfollow(uid, data.uid, callback);
			}
		});

		socket.on('api:user.saveSettings', function(data, callback) {
			if (uid) {
				user.setUserFields(uid, {
					showemail: data.showemail
				});
				callback(true);
			}
		});

		socket.on('api:topics.post', function(data) {

			topics.post(uid, data.title, data.content, data.category_id, function(err, result) {
				if(err) {
					if(err.message === 'not-logged-in') {
						socket.emit('event:alert', {
							title: 'Thank you for posting',
							message: 'Since you are unregistered, your post is awaiting approval. Click here to register now.',
							type: 'warning',
							timeout: 7500,
							clickfn: function() {
								ajaxify.go('register');
							}
						});
					} else if (err.message === 'title-too-short') {
						topics.emitTitleTooShortAlert(socket);
					} else if (err.message === 'content-too-short') {
						posts.emitContentTooShortAlert(socket);
					} else if (err.message === 'too-many-posts') {
						posts.emitTooManyPostsAlert(socket);
					} else {
						socket.emit('event:alert', {
							title: 'Error',
							message: err.message,
							type: 'warning',
							timeout: 7500
						});
					}
					return;
				}

				if (result) {
					io.sockets.in('category_' + data.category_id).emit('event:new_topic', result.topicData);
					io.sockets.in('recent_posts').emit('event:new_topic', result.topicData);
					io.sockets.in('user/' + uid).emit('event:new_post', {
						posts: result.postData
					});

					posts.getTopicPostStats();

					socket.emit('event:alert', {
						title: 'Thank you for posting',
						message: 'You have successfully posted. Click here to view your post.',
						type: 'success',
						timeout: 2000
					});
				}
			});

		});

		socket.on('api:topics.markAllRead', function(data, callback) {
			topics.markAllRead(uid, function(err, success) {
				if (!err && success) {
					callback(true);
				} else {
					callback(false);
				}
			});
		});

		socket.on('api:posts.reply', function(data) {
			if (uid < 1 && meta.config.allowGuestPosting === '0') {
				socket.emit('event:alert', {
					title: 'Reply Unsuccessful',
					message: 'You don&apos;t seem to be logged in, so you cannot reply.',
					type: 'danger',
					timeout: 2000
				});
				return;
			}

			if (Date.now() - lastPostTime < meta.config.postDelay * 1000) {
				posts.emitTooManyPostsAlert(socket);
				return;
			}

			posts.reply(data.topic_id, uid, data.content, function(err, result) {
				if(err) {

					if(err.message === 'content-too-short') {
						posts.emitContentTooShortAlert(socket);
					} else if (err.message === 'too-many-posts') {
						posts.emitTooManyPostsAlert(socket);
					} else if (err.message === 'reply-error') {
						socket.emit('event:alert', {
							title: 'Reply Unsuccessful',
							message: 'Your reply could not be posted at this time. Please try again later.',
							type: 'warning',
							timeout: 2000
						});
					}
					return;
				}

				if (result) {
					lastPostTime = Date.now();
					posts.getTopicPostStats();

					socket.emit('event:alert', {
						title: 'Reply Successful',
						message: 'You have successfully replied. Click here to view your reply.',
						type: 'success',
						timeout: 2000
					});

				}

			});
		});

		socket.on('api:user.getOnlineAnonCount', function(data, callback) {
			callback(module.exports.getOnlineAnonCount());
		});

		module.exports.getOnlineAnonCount = function () {
			return userSockets[0] ? userSockets[0].length : 0;
		}

		function emitOnlineUserCount() {
			var anon = userSockets[0] ? userSockets[0].length : 0;
			var registered = Object.keys(userSockets).length;
			if (anon)
				registered = registered - 1;

			var returnObj = {
				users: registered + anon,
				anon: anon
			};
			io.sockets.emit('api:user.active.get', returnObj)
		}

		socket.on('api:user.active.get', function() {
			emitOnlineUserCount();
		});

		socket.on('api:posts.favourite', function(data) {
			favourites.favourite(data.pid, data.room_id, uid, socket);
		});

		socket.on('api:posts.unfavourite', function(data) {
			favourites.unfavourite(data.pid, data.room_id, uid, socket);
		});

		socket.on('api:topic.delete', function(data) {
			threadTools.privileges(data.tid, uid, function(privileges) {
				if (privileges.editable) {
					threadTools.delete(data.tid, function(err) {
						if (!err) {
							posts.getTopicPostStats();
							socket.emit('api:topic.delete', {
								status: 'ok',
								tid: data.tid
							});
						}
					});
				}
			});
		});

		socket.on('api:topic.restore', function(data) {
			threadTools.privileges(data.tid, uid, function(privileges) {
				if (privileges.editable) {
					threadTools.restore(data.tid, socket, function(err) {
						posts.getTopicPostStats();

						socket.emit('api:topic.restore', {
							status: 'ok',
							tid: data.tid
						});
					});
				}
			});
		});

		socket.on('api:topic.lock', function(data) {
			threadTools.privileges(data.tid, uid, function(privileges) {
				if (privileges.editable) {
					threadTools.lock(data.tid, socket);
				}
			});
		});

		socket.on('api:topic.unlock', function(data) {
			threadTools.privileges(data.tid, uid, function(privileges) {
				if (privileges.editable) {
					threadTools.unlock(data.tid, socket);
				}
			});
		});

		socket.on('api:topic.pin', function(data) {
			threadTools.privileges(data.tid, uid, function(privileges) {
				if (privileges.editable) {
					threadTools.pin(data.tid, socket);
				}
			});
		});

		socket.on('api:topic.unpin', function(data) {
			threadTools.privileges(data.tid, uid, function(privileges) {
				if (privileges.editable) {
					threadTools.unpin(data.tid, socket);
				}
			});
		});

		socket.on('api:topic.move', function(data) {
			threadTools.move(data.tid, data.cid, socket);
		});

		socket.on('api:categories.get', function() {
			categories.getAllCategories(function(categories) {
				socket.emit('api:categories.get', categories);
			});
		});

		socket.on('api:posts.uploadImage', function(data, callback) {
			posts.uploadPostImage(data, callback);
		});

		socket.on('api:posts.getRawPost', function(data) {
			posts.getPostField(data.pid, 'content', function(err, raw) {
				socket.emit('api:posts.getRawPost', {
					post: raw
				});
			});
		});

		socket.on('api:posts.edit', function(data) {
			if(!uid) {
				socket.emit('event:alert', {
					title: 'Can&apos;t edit',
					message: 'Guests can&apos;t edit posts!',
					type: 'warning',
					timeout: 2000
				});
				return;
			} else if (!data.title || data.title.length < topics.minimumTitleLength) {
				topics.emitTitleTooShortAlert(socket);
				return;
			} else if (!data.content || data.content.length < require('../public/config.json').minimumPostLength) {
				posts.emitContentTooShortAlert(socket);
				return;
			}

			postTools.edit(uid, data.pid, data.title, data.content, data.images);
		});

		socket.on('api:posts.delete', function(data, callback) {
			postTools.delete(uid, data.pid, function(err) {
				if(err) {
					return callback(err);
				}

				posts.getTopicPostStats();

				io.sockets.in('topic_' + data.tid).emit('event:post_deleted', {
					pid: data.pid
				});
				callback(null);
			});
		});

		socket.on('api:posts.restore', function(data, callback) {
			postTools.restore(uid, data.pid, function(err) {
				if(err) {
					return callback(err);
				}

				posts.getTopicPostStats();

				io.sockets.in('topic_' + data.tid).emit('event:post_restored', {
					pid: data.pid
				});
				callback(null);
			});
		});

		socket.on('api:notifications.get', function(data, callback) {
			user.notifications.get(uid, function(notifs) {
				callback(notifs);
			});
		});

		socket.on('api:notifications.mark_read', function(nid) {
			notifications.mark_read(nid, uid);
		});

		socket.on('api:notifications.mark_all_read', function(data, callback) {
			notifications.mark_all_read(uid, function(err) {
				if (!err) callback();
			});
		});

		socket.on('api:categories.getRecentReplies', function(tid) {
			categories.getRecentReplies(tid, 4, function(replies) {
				socket.emit('api:categories.getRecentReplies', replies);
			});
		});

		socket.on('getChatMessages', function(data, callback) {
			var touid = data.touid;
			require('./messaging').getMessages(uid, touid, function(err, messages) {
				if (err)
					return callback(null);

				callback(messages);
			});
		});

		socket.on('sendChatMessage', function(data) {

			var touid = data.touid;
			if (touid === uid || uid === 0) {
				return;
			}

			var msg = utils.strip_tags(data.message);

			user.getUserField(uid, 'username', function(err, username) {
				var finalMessage = username + ' : ' + msg,
					notifText = 'New message from <strong>' + username + '</strong>';

				if (!isUserOnline(touid)) {
					notifications.create(notifText, 'javascript:app.openChat(&apos;' + username + '&apos;, ' + uid + ');', 'notification_' + uid + '_' + touid, function(nid) {
						notifications.push(nid, [touid], function(success) {

						});
					});
				}

				require('./messaging').addMessage(uid, touid, msg, function(err, message) {
					var numSockets = 0;

					if (userSockets[touid]) {
						numSockets = userSockets[touid].length;

						for (var x = 0; x < numSockets; ++x) {
							userSockets[touid][x].emit('chatMessage', {
								fromuid: uid,
								username: username,
								message: finalMessage,
								timestamp: Date.now()
							});
						}
					}

					if (userSockets[uid]) {

						numSockets = userSockets[uid].length;

						for (var x = 0; x < numSockets; ++x) {
							userSockets[uid][x].emit('chatMessage', {
								fromuid: touid,
								username: username,
								message: 'You : ' + msg,
								timestamp: Date.now()
							});
						}
					}
				});
			});
		});

		socket.on('api:config.get', function(data) {
			meta.configs.list(function(err, config) {
				if (!err) socket.emit('api:config.get', config);
			});
		});

		socket.on('api:config.set', function(data) {
			meta.configs.set(data.key, data.value, function(err) {
				if (!err) {
					socket.emit('api:config.set', {
						status: 'ok'
					});

					plugins.fireHook('action:config.set', {
						key: data.key,
						value: data.value
					});
				}

				logger.monitorConfig(this, data);
			});
		});

		socket.on('api:config.remove', function(key) {
			meta.configs.remove(key);
		});

		socket.on('api:composer.push', function(data) {
			if (uid > 0 || meta.config.allowGuestPosting === '1') {
				if (parseInt(data.tid) > 0) {
					topics.getTopicData(data.tid, function(err, topicData) {
						if (data.body)
							topicData.body = data.body;

						socket.emit('api:composer.push', {
							tid: data.tid,
							title: topicData.title,
							body: topicData.body
						});
					});
				} else if (parseInt(data.cid) > 0) {
					user.getUserFields(uid, ['username', 'picture'], function(err, userData) {
						if (!err && userData) {
							socket.emit('api:composer.push', {
								tid: 0,
								cid: data.cid,
								username: userData.username,
								picture: userData.picture,
								title: undefined
							});
						}
					});
				} else if (parseInt(data.pid) > 0) {

					async.parallel([
						function(next) {
							posts.getPostFields(data.pid, ['content'], next);
						},
						function(next) {
							topics.getTitleByPid(data.pid, function(title) {
								next(null, title);
							});
						}
					], function(err, results) {
						socket.emit('api:composer.push', {
							title: results[1],
							pid: data.pid,
							body: results[0].content
						});
					});
				}
			} else {
				socket.emit('api:composer.push', {
					error: 'no-uid'
				});
			}
		});

		socket.on('api:composer.editCheck', function(pid) {
			posts.getPostField(pid, 'tid', function(err, tid) {
				postTools.isMain(pid, tid, function(isMain) {
					socket.emit('api:composer.editCheck', {
						titleEditable: isMain
					});
				})
			})
		});

		socket.on('api:post.privileges', function(pid) {
			postTools.privileges(pid, uid, function(privileges) {
				privileges.pid = parseInt(pid);
				socket.emit('api:post.privileges', privileges);
			});
		});

		socket.on('api:topic.followCheck', function(tid) {
			threadTools.isFollowing(tid, uid, function(following) {
				socket.emit('api:topic.followCheck', following);
			});
		});

		socket.on('api:topic.follow', function(tid) {
			if (uid && uid > 0) {
				threadTools.toggleFollow(tid, uid, function(follow) {
					if (follow.status === 'ok') socket.emit('api:topic.follow', follow);
				});
			} else {
				socket.emit('api:topic.follow', {
					status: 'error',
					error: 'not-logged-in'
				});
			}
		});

		socket.on('api:topic.loadMore', function(data, callback) {
			var start = data.after,
				end = start + 9;

			topics.getTopicPosts(data.tid, start, end, uid, function(posts) {
				callback({
					posts: posts
				});
			});
		});

		socket.on('api:category.loadMore', function(data, callback) {
			var start = data.after,
				end = start + 9;

			categories.getCategoryTopics(data.cid, start, end, uid, function(topics) {
				callback({
					topics: topics
				});
			});
		});

		socket.on('api:topics.loadMoreRecentTopics', function(data, callback) {
			var start = data.after,
				end = start + 9;

			topics.getLatestTopics(uid, start, end, data.term, function(err, latestTopics) {
				if (!err) {
					callback(latestTopics);
				} else {
					winston.error('[socket api:topics.loadMoreRecentTopics] ' + err.message);
				}
			});
		});

		socket.on('api:topics.loadMoreUnreadTopics', function(data, callback) {
			var start = data.after,
				end = start + 9;

			topics.getUnreadTopics(uid, start, end, function(unreadTopics) {
				callback(unreadTopics);
			});
		});

		socket.on('api:users.loadMore', function(data, callback) {
			var start = data.after,
				end = start + 19;

			user.getUsers(data.set, start, end, function(err, data) {
				if (err) {
					winston.err(err);
				} else {
					callback({
						users: data
					});
				}
			});
		});

		socket.on('api:admin.topics.getMore', function(data, callback) {
			topics.getAllTopics(data.limit, data.after, function(err, topics) {
				callback(JSON.stringify(topics));
			});
		});

		socket.on('api:admin.categories.create', function(data, callback) {
			admin.categories.create(data, function(err, data) {
				callback(err, data);
			});
		});

		socket.on('api:admin.categories.update', function(data) {
			admin.categories.update(data, socket);
		});

		socket.on('api:admin.user.makeAdmin', function(theirid) {
			if (uid && uid > 0) {
				admin.user.makeAdmin(uid, theirid, socket);
			}
		});

		socket.on('api:admin.user.removeAdmin', function(theirid) {
			if (uid && uid > 0) {
				admin.user.removeAdmin(uid, theirid, socket);
			}
		});

		socket.on('api:admin.user.deleteUser', function(theirid) {
			if (uid && uid > 0) {
				admin.user.deleteUser(uid, theirid, socket);
			}
		});

		socket.on('api:admin.user.banUser', function(theirid) {
			if (uid && uid > 0) {
				admin.user.banUser(uid, theirid, socket, function(isBanned) {
					if(isBanned) {
						if(userSockets[theirid]) {
							for(var i=0; i<userSockets[theirid].length; ++i) {
								userSockets[theirid][i].emit('event:banned');
							}
						}
						module.exports.logoutUser(theirid);
					}
				});
			}
		});

		socket.on('api:admin.user.unbanUser', function(theirid) {
			if (uid && uid > 0) {
				admin.user.unbanUser(uid, theirid, socket);
			}
		});

		socket.on('api:admin.user.search', function(username, callback) {
			if (uid && uid > 0) {
				user.search(username, function(data) {
					if (!callback) socket.emit('api:admin.user.search', data);
					else callback(null, data);
				});
			} else {
				if (!callback) socket.emit('api:admin.user.search', null);
				else callback();
			}
		});

		socket.on('api:admin.themes.getInstalled', function(callback) {
			meta.themes.get(function(err, themeArr) {
				callback(themeArr);
			});
		});

		socket.on('api:admin.plugins.toggle', function(plugin_id) {
			plugins.toggleActive(plugin_id, function(status) {
				socket.emit('api:admin.plugins.toggle', status);
			});
		});

		socket.on('api:meta.buildTitle', function(text, callback) {
			meta.title.build(text, uid, function(err, title, numNotifications) {
				callback(title, numNotifications);
			});
		});

		/*
			GROUPS
		*/

		socket.on('api:groups.create', function(data, callback) {
			Groups.create(data.name, data.description, function(err, groupObj) {
				callback(err ? err.message : null, groupObj || undefined);
			});
		});

		socket.on('api:groups.delete', function(gid, callback) {
			Groups.destroy(gid, function(err) {
				callback(err ? err.message : null, err ? null : 'OK');
			});
		});

		socket.on('api:groups.get', function(gid, callback) {
			Groups.get(gid, {
				expand: true
			}, function(err, groupObj) {
				callback(err ? err.message : null, groupObj || undefined);
			});
		});

		socket.on('api:groups.join', function(data, callback) {
			Groups.join(data.gid, data.uid, callback);
		});

		socket.on('api:groups.leave', function(data, callback) {
			Groups.leave(data.gid, data.uid, callback);
		});

		socket.on('api:groups.update', function(data, callback) {
			Groups.update(data.gid, data.values, function(err) {
				callback(err ? err.message : null);
			});
		});

		socket.on('api:admin.theme.set', meta.themes.set);
	});

}
