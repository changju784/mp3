var bodyParser = require('body-parser');
var User = require('../models/user');
var Task = require('../models/task');
var mongoose = require('mongoose');

module.exports = function (router) {

    // helper to parse JSON query params safely
    function parseJSONParam(val) {
        if (!val) return undefined;
        if (typeof val === 'object') return val;
        try {
            return JSON.parse(val);
        } catch (e) {
            return undefined;
        }
    }

    // uniform response helpers
    function sendSuccess(res, status, message, data) {
        // For 204 No Content, send empty body per HTTP spec
        if (status === 204) return res.status(204).send();
        return res.status(status).json({ message: message, data: data });
    }
    function sendError(res, status, message, data) {
        return res.status(status).json({ message: message, data: data });
    }

    // helper to validate ObjectId and sanitize id errors
    function validIdOr404(id, res) {
        if (!mongoose.Types.ObjectId.isValid(id)) {
            sendError(res, 404, 'Not Found', 'Resource not found');
            return false;
        }
        return true;
    }

    // helper to validate email and date
    function isValidEmail(email) {
        if (!email || typeof email !== 'string') return false;
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }
    function isValidDate(value) {
        var d = new Date(value);
        return !isNaN(d.getTime());
    }

    // USERS
    var usersRoute = router.route('/users');

    // GET /api/users with query params
    usersRoute.get(function (req, res) {
        var where = parseJSONParam(req.query.where) || {};
        var sort = parseJSONParam(req.query.sort);
        var select = parseJSONParam(req.query.select);
        var skip = parseInt(req.query.skip) || 0;
        var limit = typeof req.query.limit !== 'undefined' ? parseInt(req.query.limit) : 0; // unlimited default
        var count = req.query.count === 'true' || req.query.count === true;

        var q = User.find(where);
        if (sort) q = q.sort(sort);
        if (select) q = q.select(select);
        if (skip) q = q.skip(skip);
        if (limit) q = q.limit(limit);

        if (count) {
            q.countDocuments(function (err, cnt) {
                if (err) return sendError(res, 500, 'Internal Server Error', 'Error counting users');
                return sendSuccess(res, 200, 'OK', cnt);
            });
        } else {
            q.exec(function (err, users) {
                if (err) return sendError(res, 500, 'Internal Server Error', 'Error fetching users');
                return sendSuccess(res, 200, 'OK', users);
            });
        }
    });

    // POST /api/users create new user
    usersRoute.post(function (req, res) {
        var body = req.body || {};
        if (!body.name || !body.email) return sendError(res, 400, 'Bad Request', 'User must have name and email');
        if (!isValidEmail(body.email)) return sendError(res, 400, 'Bad Request', 'Invalid email format');

        var user = new User({
            name: body.name,
            email: body.email,
            pendingTasks: Array.isArray(body.pendingTasks) ? body.pendingTasks : [],
        });

        user.save(function (err, saved) {
            if (err) {
                if (err.code === 11000) return sendError(res, 400, 'Bad Request', 'A user with that email already exists');
                return sendError(res, 500, 'Internal Server Error', 'Error saving user');
            }
            return sendSuccess(res, 201, 'Created', saved);
        });
    });

    // /users/:id
    var userIdRoute = router.route('/users/:id');

    userIdRoute.get(function (req, res) {
        if (!validIdOr404(req.params.id, res)) return;
        var select = parseJSONParam(req.query.select);
        var q = User.findById(req.params.id);
        if (select) q = q.select(select);
        q.exec(function (err, user) {
            if (err) return sendError(res, 404, 'Not Found', 'User not found');
            if (!user) return sendError(res, 404, 'Not Found', 'User not found');
            return sendSuccess(res, 200, 'OK', user);
        });
    });

    // PUT replace user entirely
    userIdRoute.put(function (req, res) {
        var body = req.body || {};
        if (!body.name || !body.email) return sendError(res, 400, 'Bad Request', 'User must have name and email');
        if (!isValidEmail(body.email)) return sendError(res, 400, 'Bad Request', 'Invalid email format');

        if (!validIdOr404(req.params.id, res)) return;

        User.findById(req.params.id, function (err, user) {
            if (err || !user) return sendError(res, 404, 'Not Found', 'User not found');

            // store old pending tasks for cleanup
            var oldPending = user.pendingTasks || [];

            user.name = body.name;
            user.email = body.email;
            user.pendingTasks = Array.isArray(body.pendingTasks) ? body.pendingTasks : [];

            user.save(function (err, saved) {
                if (err) {
                    if (err.code === 11000) return sendError(res, 400, 'Bad Request', 'A user with that email already exists');
                    return sendError(res, 500, 'Internal Server Error', 'Error saving user');
                }

                // Ensure two-way references: for tasks in saved.pendingTasks, set task assignedUser
                // First, remove this user from tasks that are no longer pending
                var toRemove = oldPending.filter(function (t) { return saved.pendingTasks.indexOf(t) === -1; });
                var toAdd = saved.pendingTasks.filter(function (t) { return oldPending.indexOf(t) === -1; });

                // Clear tasks that are no longer pending for this user
                Task.updateMany({ _id: { $in: toRemove } }, { $set: { assignedUser: '', assignedUserName: 'unassigned' } }, function (e) {
                    if (e) console.error('Error clearing tasks on user update', e);

                    // Only assign tasks that are not completed. Completed tasks should not be pending.
                    if (!toAdd || toAdd.length === 0) return sendSuccess(res, 200, 'OK', saved);

                    Task.find({ _id: { $in: toAdd }, completed: false }, function (e3, tasksToAssign) {
                        if (e3) {
                            console.error('Error finding tasks to assign on user update', e3);
                            return sendSuccess(res, 200, 'OK', saved);
                        }

                        var idsToAssign = (tasksToAssign || []).map(function (t) { return t._id; });
                        if (!idsToAssign || idsToAssign.length === 0) return sendSuccess(res, 200, 'OK', saved);

                        Task.updateMany({ _id: { $in: idsToAssign } }, { $set: { assignedUser: saved._id.toString(), assignedUserName: saved.name } }, function (e2) {
                            if (e2) console.error('Error assigning tasks on user update', e2);
                            return sendSuccess(res, 200, 'OK', saved);
                        });
                    });
                });
            });
        });
    });

    // DELETE user
    userIdRoute.delete(function (req, res) {
        if (!validIdOr404(req.params.id, res)) return;
        User.findById(req.params.id, function (err, user) {
            if (err || !user) return sendError(res, 404, 'Not Found', 'User not found');

            var pending = user.pendingTasks || [];
            // remove user
            user.remove(function (err) {
                if (err) return sendError(res, 500, 'Internal Server Error', 'Error deleting user');

                // unassign pending tasks
                Task.updateMany({ _id: { $in: pending } }, { $set: { assignedUser: '', assignedUserName: 'unassigned' } }, function (e) {
                    if (e) console.error('Error unassigning tasks on user delete', e);
                    return sendSuccess(res, 204, 'No Content', null);
                });
            });
        });
    });

    // TASKS
    var tasksRoute = router.route('/tasks');

    tasksRoute.get(function (req, res) {
        var where = parseJSONParam(req.query.where) || {};
        var sort = parseJSONParam(req.query.sort);
        var select = parseJSONParam(req.query.select);
        var skip = parseInt(req.query.skip) || 0;
        var limit = typeof req.query.limit !== 'undefined' ? parseInt(req.query.limit) : 100;
        var count = req.query.count === 'true' || req.query.count === true;

        var q = Task.find(where);
        if (sort) q = q.sort(sort);
        if (select) q = q.select(select);
        if (skip) q = q.skip(skip);
        if (limit) q = q.limit(limit);

        if (count) {
            q.countDocuments(function (err, cnt) {
                if (err) return sendError(res, 500, 'Internal Server Error', 'Error counting tasks');
                return sendSuccess(res, 200, 'OK', cnt);
            });
        } else {
            q.exec(function (err, tasks) {
                if (err) return sendError(res, 500, 'Internal Server Error', 'Error fetching tasks');
                return sendSuccess(res, 200, 'OK', tasks);
            });
        }
    });

    tasksRoute.post(function (req, res) {
        var body = req.body || {};
        if (!body.name || !body.deadline) return sendError(res, 400, 'Bad Request', 'Task must have name and deadline');
        if (!isValidDate(body.deadline)) return sendError(res, 400, 'Bad Request', 'Invalid deadline');

        var task = new Task({
            name: body.name,
            description: body.description || '',
            deadline: body.deadline,
            completed: !!body.completed,
            assignedUser: body.assignedUser || '',
            assignedUserName: body.assignedUserName || (body.assignedUser ? 'assigned' : 'unassigned')
        });

        task.save(function (err, saved) {
            if (err) return sendError(res, 500, 'Internal Server Error', 'Error saving task');

            // If assigned to a user, add to user's pendingTasks unless completed
            if (saved.assignedUser && !saved.completed) {
                User.findById(saved.assignedUser, function (e, user) {
                    if (e || !user) return sendSuccess(res, 201, 'Created', saved);
                    if (user.pendingTasks.indexOf(saved._id.toString()) === -1) {
                        user.pendingTasks.push(saved._id.toString());
                        user.save(function () { return sendSuccess(res, 201, 'Created', saved); });
                    } else {
                        return sendSuccess(res, 201, 'Created', saved);
                    }
                });
            } else {
                return sendSuccess(res, 201, 'Created', saved);
            }
        });
    });

    var taskIdRoute = router.route('/tasks/:id');

    taskIdRoute.get(function (req, res) {
        if (!validIdOr404(req.params.id, res)) return;
        var select = parseJSONParam(req.query.select);
        var q = Task.findById(req.params.id);
        if (select) q = q.select(select);
        q.exec(function (err, task) {
            if (err) return sendError(res, 404, 'Not Found', 'Task not found');
            if (!task) return sendError(res, 404, 'Not Found', 'Task not found');
            return sendSuccess(res, 200, 'OK', task);
        });
    });

    taskIdRoute.put(function (req, res) {
        var body = req.body || {};
        if (!body.name || !body.deadline) return sendError(res, 400, 'Bad Request', 'Task must have name and deadline');
        if (!isValidDate(body.deadline)) return sendError(res, 400, 'Bad Request', 'Invalid deadline');

        if (!validIdOr404(req.params.id, res)) return;

        Task.findById(req.params.id, function (err, task) {
            if (err || !task) return sendError(res, 404, 'Not Found', 'Task not found');

            var oldAssigned = task.assignedUser || '';

            task.name = body.name;
            task.description = body.description || '';
            task.deadline = body.deadline;
            task.completed = !!body.completed;
            task.assignedUser = body.assignedUser || '';
            task.assignedUserName = body.assignedUserName || (body.assignedUser ? 'assigned' : 'unassigned');

            task.save(function (err, saved) {
                if (err) return sendError(res, 500, 'Internal Server Error', 'Error saving task');

                // maintain two-way refs
                // if assigned changed, remove from old user's pendingTasks and add to new user's pendingTasks (if not completed)
                var newAssigned = saved.assignedUser || '';
                var ops = [];
                if (oldAssigned && oldAssigned !== newAssigned) {
                    ops.push(function (cb) {
                        User.findById(oldAssigned, function (e, u) {
                            if (u) {
                                u.pendingTasks = (u.pendingTasks || []).filter(function (tid) { return tid !== saved._id.toString(); });
                                u.save(function () { cb(); });
                            } else cb();
                        });
                    });
                }
                if (newAssigned && (!saved.completed)) {
                    ops.push(function (cb) {
                        User.findById(newAssigned, function (e, u) {
                            if (u) {
                                if ((u.pendingTasks || []).indexOf(saved._id.toString()) === -1) u.pendingTasks.push(saved._id.toString());
                                u.save(function () { cb(); });
                            } else cb();
                        });
                    });
                }

                // run ops sequentially
                (function run(i) {
                    if (i >= ops.length) return sendSuccess(res, 200, 'OK', saved);
                    ops[i](function () { run(i + 1); });
                })(0);
            });
        });
    });

    taskIdRoute.delete(function (req, res) {
        Task.findById(req.params.id, function (err, task) {
            if (err || !task) return sendError(res, 404, 'Not Found', 'Task not found');

            var assigned = task.assignedUser || '';
            task.remove(function (err) {
                if (err) return sendError(res, 500, 'Internal Server Error', 'Error deleting task');

                if (assigned) {
                    User.findById(assigned, function (e, user) {
                        if (user) {
                            user.pendingTasks = (user.pendingTasks || []).filter(function (tid) { return tid !== req.params.id; });
                            user.save(function () { return sendSuccess(res, 204, 'No Content', null); });
                        } else return sendSuccess(res, 204, 'No Content', null);
                    });
                } else {
                    return sendSuccess(res, 204, 'No Content', null);
                }
            });
        });
    });

    return router;
};
