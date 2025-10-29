var mongoose = require('mongoose');
var User = require('./models/user');
var Task = require('./models/task');

module.exports = {
    isValidEmail: function (email) {
        if (!email || typeof email !== 'string') return false;
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    },
    isValidDate: function (value) {
        var d = new Date(value);
        return !isNaN(d.getTime());
    },

    // Find user by id or by name when id not provided
    // callback receives { valid: boolean, user?: User, error?: string }
    findUserByIdOrName: function (assignedUser, assignedUserName, callback) {
        if (!assignedUser && !assignedUserName) return callback({ valid: true, user: null });

        if (assignedUser) {
            if (!mongoose.Types.ObjectId.isValid(assignedUser)) {
                return callback({ valid: false, error: 'Invalid assignedUser ID format' });
            }
            User.findById(assignedUser, function (err, user) {
                if (err || !user) return callback({ valid: false, error: 'Assigned user does not exist' });
                if (assignedUserName && assignedUserName !== user.name) return callback({ valid: false, error: 'Assigned user name does not match the user' });
                return callback({ valid: true, user: user });
            });
            return;
        }

        // assignedUser not provided but assignedUserName provided: find by name
        User.find({ name: assignedUserName }, function (err, users) {
            if (err) return callback({ valid: false, error: 'Error searching for user by name' });
            if (!users || users.length === 0) return callback({ valid: false, error: 'Assigned user name does not exist' });
            if (users.length > 1) return callback({ valid: false, error: 'Multiple users with that name' });
            return callback({ valid: true, user: users[0] });
        });
    },

    // Validate pendingTasks array: ensure all IDs valid, tasks exist, and are not completed
    // callback receives { valid: boolean, tasks?: [Task], error?: string }
    validatePendingTasks: function (pendingTasks, callback) {
        if (!pendingTasks) return callback({ valid: true, tasks: [] });
        if (!Array.isArray(pendingTasks)) return callback({ valid: false, error: 'pendingTasks must be an array' });
        if (pendingTasks.length === 0) return callback({ valid: true, tasks: [] });

        // check ObjectId validity
        var invalidIds = pendingTasks.filter(function (id) { return !mongoose.Types.ObjectId.isValid(id); });
        if (invalidIds.length) return callback({ valid: false, error: 'Invalid task id(s): ' + invalidIds.join(', ') });

        // fetch tasks
        Task.find({ _id: { $in: pendingTasks } }, function (err, tasks) {
            if (err) return callback({ valid: false, error: 'Error fetching tasks' });
            var foundIds = tasks.map(function (t) { return t._id.toString(); });
            var missing = pendingTasks.filter(function (id) { return foundIds.indexOf(id) === -1; });
            if (missing.length) return callback({ valid: false, error: 'Task id(s) not found: ' + missing.join(', ') });

            // ensure none are completed
            var completed = tasks.filter(function (t) { return t.completed; }).map(function (t) { return t._id.toString(); });
            if (completed.length) return callback({ valid: false, error: 'Tasks already completed cannot be pending: ' + completed.join(', ') });

            return callback({ valid: true, tasks: tasks });
        });
    }
};
