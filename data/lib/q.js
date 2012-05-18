// vim:ts=4:sts=4:sw=4:
/*!
 *
 * Copyright 2007-2009 Tyler Close under the terms of the MIT X license found
 * at http://www.opensource.org/licenses/mit-license.html
 * Forked at ref_send.js version: 2009-05-11
 *
 * Copyright 2009-2011 Kris Kowal under the terms of the MIT
 * license found at http://github.com/kriskowal/q/raw/master/LICENSE
 *
 */

(function (definition) {

    // This file will function properly as a <script> tag, or a module
    // using CommonJS and NodeJS or RequireJS module formats.  In
    // Common/Node/RequireJS, the module exports the Q API and when
    // executed as a simple <script>, it creates a Q global instead.

    // RequireJS
    if (typeof define === "function") {
        define(definition);
    // CommonJS
    } else if (typeof exports === "object") {
        definition(require, exports);
    // <script>
    } else {
        definition(void 0, Q = {});
    }

})(function (serverSideRequire, exports) {
"use strict";


var nextTick;
try {
    // Narwhal, Node (with a package, wraps process.nextTick)
    // "require" is renamed to "serverSideRequire" so
    // client-side scrapers do not try to load
    // "event-queue".
    nextTick = serverSideRequire("event-queue").enqueue;
} catch (e) {
    // browsers
    if (typeof MessageChannel !== "undefined") {
        // modern browsers
        // http://www.nonblocking.io/2011/06/windownexttick.html
        var channel = new MessageChannel();
        // linked list of tasks (single, with head node)
        var head = {}, tail = head;
        channel.port1.onmessage = function () {
            var next = head.next;
            var task = next.task;
            head = next;
            task();
        };
        nextTick = function (task) {
            tail = tail.next = {task: task};
            channel.port2.postMessage();
        };
    } else {
        // old browsers
        nextTick = function (task) {
            setTimeout(task, 0);
        };
    }
}

// useful for an identity stub and default resolvers
function identity (x) {return x;}

// shims
var shim = function (object, name, shim) {
    if (!object[name])
        object[name] = shim;
    return object[name];
};

var freeze = shim(Object, "freeze", identity);

var create = shim(Object, "create", function (prototype) {
    var Type = function () {};
    Type.prototype = prototype;
    return new Type();
});

var keys = shim(Object, "keys", function (object) {
    var keys = [];
    for (var key in object)
        keys.push(key);
    return keys;
});

var reduce = Array.prototype.reduce || function (callback, basis) {
    var i = 0,
        ii = this.length;
    // concerning the initial value, if one is not provided
    if (arguments.length == 1) {
        // seek to the first value in the array, accounting
        // for the possibility that is is a sparse array
        do {
            if (i in this) {
                basis = this[i++];
                break;
            }
            if (++i >= ii)
                throw new TypeError();
        } while (1);
    }
    // reduce
    for (; i < ii; i++) {
        // account for the possibility that the array is sparse
        if (i in this) {
            basis = callback(basis, this[i], i);
        }
    }
    return basis;
};

var isStopIteration = function (exception) {
    return Object.prototype.toString.call(exception)
        === "[object StopIteration]";
};

// Abbreviations for performance and minification
var slice = Array.prototype.slice;
var valueOf = function (value) {
    if (value === void 0 || value === null) {
        return value;
    } else {
        return value.valueOf();
    }
};

/**
 * Performs a task in a future turn of the event loop.
 * @param {Function} task
 */
exports.nextTick = nextTick;


////////////////////////////////////////////////////////////////////////////////
// Logging Support

var trace_defer = null,
    trace_resolve = null,
    trace_reject = null,
    trace_exception = null,
    trace_send_issue = null,
    trace_before_run = null,
    trace_after_run = null;

exports.loggingDisable = function() {
  trace_defer = null;
  trace_resolve = null;
  trace_reject = null;
  trace_exception = null;
  trace_send_issue = null;
  trace_before_run = null;
  trace_after_run = null;
};


////////////////////////////////////////////////////////////////////////////////
// Causeway Logging Support
//
// Anchors: We imitate JS causeway's instrument.js.  The anchor always uses a
//  number of 1, its turn always uses the same loop id, and the turn's number
//  increments every time a log entry is generated.
//

var causeway_log = null,
    causeway_turn_loop = 'L0',
    causeway_turn_num = 0, causeway_num_this_turn = 1,
    // id's issued for deferreds and messages
    causeway_id = 0,
    causeway_capture_stack, causeway_transform_stack,
    causeway_active_runs = [];

function causeway_normalize_reason(reason) {
  return reason;
}

function causeway_trace_defer(deferred, annotation) {
  deferred.annotation = annotation;
  deferred._causeway_id = 'C' + causeway_id++;
  deferred._causeway_done = false;
}
var CAUSEWAY_RESOLVED_CLASSES = ["org.ref_send.log.Fulfilled",
                                 "org.ref_send.log.Resolved",
                                 "org.ref_send.log.Event"];
function causeway_trace_resolve(deferred, value, pending, stopStacktraceAt) {
  var trace_context = ['M' + causeway_id++,
                       causeway_capture_stack(stopStacktraceAt)];
  // if this deferred was rejected, this is not a fulfillment
  if (deferred._causeway_done)
    return trace_context;
  causeway_log.push({
    "class": CAUSEWAY_RESOLVED_CLASSES,
    anchor: {
      number: causeway_num_this_turn++,
      turn: {
        loop: causeway_turn_loop,
        number: causeway_turn_num,
      }
    },
    timestamp: Date.now(),
    trace: trace_context[1],
    condition: deferred._causeway_id
  });
  return trace_context;
}
var CAUSEWAY_REJECTED_CLASSES = ["org.ref_send.log.Rejected",
                                 "org.ref_send.log.Resolved",
                                 "org.ref_send.log.Event"];
function causeway_trace_reject(deferred, reason, stopStacktraceAt) {
  deferred._causeway_done = true;
  causeway_log.push({
    "class": CAUSEWAY_REJECTED_CLASSES,
    anchor: {
      number: causeway_num_this_turn++,
      turn: {
        loop: causeway_turn_loop,
        number: causeway_turn_num,
      }
    },
    timestamp: Date.now(),
    trace: causeway_capture_stack(stopStacktraceAt),
    condition: deferred._causeway_id,
    reason: causeway_normalize_reason(reason)
  });
}
var CAUSEWAY_PROBLEM_CLASSES = ["org.ref_send.log.Problem",
                                "org.ref_send.log.Comment",
                                "org.ref_send.log.Event"];
function causeway_trace_exception(deferred, exception, during, value) {
  causeway_log.push({
    "class": CAUSEWAY_PROBLEM_CLASSES,
    anchor: {
      number: causeway_num_this_turn++,
      turn: {
        loop: causeway_turn_loop,
        number: causeway_turn_num,
      }
    },
    timestamp: Date.now(),
    trace: causeway_transform_stack(exception),
    text: exception.message,
    reason: {
      "class": ["Error"]
    }
  });
}
var CAUSEWAY_SENT_CLASSES = ["org.ref_send.log.Sent",
                             "org.ref_send.log.Event"];
function causeway_trace_send_issue(deferred, value, args, stopStacktraceAt) {
  var msgId = 'M' + causeway_id++,
      stack = causeway_capture_stack(stopStacktraceAt), rec;
  causeway_log.push(rec = {
    "class": CAUSEWAY_SENT_CLASSES,
    anchor: {
      number: causeway_num_this_turn++,
      turn: {
        loop: causeway_turn_loop,
        number: causeway_turn_num,
      }
    },
    timestamp: Date.now(),
    trace: stack,
    condition: deferred._causeway_id,
    message: msgId
  });
  if (deferred.annotation) {
    // the causality grid uses a fix [length - 2] subscripting for major type
    //  detection, so let's avoid changing its logic for now.
    //rec["class"].push("org.ref_send.log.Comment");
    rec.text = deferred.annotation;
  }
  return [msgId, stack];
}
var CAUSEWAY_GOT_CLASSES = ["org.ref_send.log.Got",
                            "org.ref_send.log.Event"];
function causeway_trace_before_run(trace_context, deferred, value, args) {
  // if anything happened in the current turn, we need a new turn number
  if (causeway_num_this_turn > 1) {
    causeway_turn_num++;
    causeway_num_this_turn = 1;
  }

  causeway_active_runs.push(deferred);
  causeway_log.push({
    "class": CAUSEWAY_GOT_CLASSES,
    anchor: {
      number: causeway_num_this_turn++,
      turn: {
        loop: causeway_turn_loop,
        number: causeway_turn_num,
      }
    },
    timestamp: Date.now(),
    trace: trace_context[1],
    message: trace_context[0],
  });
}
var CAUSEWAY_DONE_CLASSES = ["org.ref_send.log.Done",
                             "org.ref_send.log.Event"];
function causeway_trace_after_run(trace_context, deferred, value, args) {
  causeway_active_runs.pop();
  causeway_log.push({
    "class": CAUSEWAY_DONE_CLASSES,
    anchor: {
      number: causeway_num_this_turn++,
      turn: {
        loop: causeway_turn_loop,
        number: causeway_turn_num,
      }
    },
    timestamp: Date.now(),
  });
  // Since we are 'losing control' of the event loop, be sure to increment the
  //  turn.
  causeway_turn_num++;
  causeway_num_this_turn = 1;
}

function causeway_transform_v8_stack(ex) {
  var frames = ex.stack, calls = [];
  for (var i = 0; i < frames.length; i++) {
    var frame = frames[i];
    // from http://code.google.com/p/causeway/
    //        src/js/com/teleometry/causeway/log/html/instrument.js
    calls.push({
        name: frame.getFunctionName() ||
              (frame.getTypeName() + '.' + (frame.getMethodName() || '')),
        source: /^[^?#]*/.exec(frame.getFileName())[0], // ^ OK on URL
        span: [ [ frame.getLineNumber(), frame.getColumnNumber() ] ]
      });
  }
  return {
    calls: calls
  };
}
function causeway_transform_spidermonkey_stack(ex) {
  var sframes = ex.stack.split("\n"), calls = [], match;
  for (var i = 0; i < sframes.length; i++) {
    if ((match = /^(.*)@(.+):(\d+)$/.exec(sframes[i]))) {
      frames.push({
        filename: simplifyFilename(match[2]),
        lineNo: match[3],
        funcName: match[1],
      });
    }
  }
  return {
    calls: calls
  };
}
function causeway_transform_opera_stack(ex) {
  // XXX use the pub domain regex impl from
  //   https://github.com/eriwen/javascript-stacktrace/blob/master/stacktrace.js
  throw Error("XXX");
}

function causeway_capture_v8_stack(constructorOpt) {
  var ex = {};
  Error.captureStackTrace(ex, constructorOpt || causeway_capture_v8_stack);
  return causeway_transform_stack(ex);
}
function causeway_capture_spidermonkey_stack() {
  try {
    throw new Error();
  }
  catch (ex) {
    return causeway_transform_stack(ex);
  }
}
function causeway_capture_opera_stack() {
  try {
    throw new Error();
  }
  catch (ex) {
    return causeway_transform_stack(ex);
  }
}

exports.loggingEnableCauseway = function(options) {
  options = options || {};

  trace_defer = causeway_trace_defer;
  trace_resolve = causeway_trace_resolve;
  trace_reject = causeway_trace_reject;
  trace_exception = causeway_trace_exception;
  trace_send_issue = causeway_trace_send_issue;
  trace_before_run = causeway_trace_before_run;
  trace_after_run = causeway_trace_after_run;

  // (V8 or clobbered to resemble V8)
  if ("captureStackTrace" in Error) {
    causeway_capture_stack = causeway_capture_v8_stack;
    causeway_transform_stack = causeway_transform_v8_stack;
  }
  // other (spidermonkey or opera 11+)
  else {
    var ex = null;
    try {
      throw new Error();
    }
    catch (e) {
      ex = e;
    }

    // spidermonkey
    if (typeof(ex.stack) === "string") {
      causeway_capture_stack = causeway_capture_spidermonkey_stack;
      causeway_transform_stack = causeway_transform_spidermonkey_stack;
    }
    // opera
    else if (typeof(ex.stacktrace) === "string") {
      causeway_capture_stack = causeway_capture_opera_stack;
      causeway_transform_stack = causeway_transform_opera_stack;
    }
    else {
      throw new Error("Unable to figure out stack trace mechanism.");
    }
  }
  // Callers may already have their own prepareStackTrace in effect; we don't
  // want to stomp on that or cause its value to continually change, so allow
  // them to provide a helper transformation function.
  if ("transformStack" in options) {
    causeway_transform_stack = options.transformStack;
  }
  // Overwrite the prepareStackTrace, sketchy.
  else if (causeway_capture_stack === causeway_capture_v8_stack) {
    Error.prepareStackTrace = function(ex, stack) {
      return stack;
    };
  }

  causeway_log = [];
};

exports.causewayResetLog = function() {
  var oldLog = causeway_log;
  causeway_log = [];
  return oldLog;
};

////////////////////////////////////////////////////////////////////////////////
// Friendly Logging Support

var friendly_unhandled_rejection_handler = null,
    friendly_unresolved_deferreds = null,
    friendly_annotation_generator = null;
function friendly_trace_defer(deferred, annotation) {
  if (friendly_unresolved_deferreds) {
    if (!annotation && friendly_annotation_generator)
      annotation = friendly_annotation_generator();
    deferred.annotation = annotation;
    friendly_unresolved_deferreds.push(deferred);
  }
}
function friendly_trace_resolve(deferred, value, pending) {
  if (friendly_unresolved_deferreds) {
    var index = friendly_unresolved_deferreds.indexOf(deferred);
    if (index !== -1)
      friendly_unresolved_deferreds.splice(index, 1);
  }
  if (isRejected(value) && pending.length === 0) {
    friendly_unhandled_rejection_handler(value.valueOf().reason);
  }
}

function friendly_throw(ex) {
  throw ex;
}

/**
 * Enable warnings when a promise is rejected but there is nothing listening.
 *
 * Other possibilities:
 * - Track unresolved deferreds, be able to regurgitate a list of them at any
 *   point, possibly with backtraces / chaining.
 */
exports.loggingEnableFriendly = function(options) {
  exports.loggingDisable();
  friendly_unhandled_rejection_handler = null;
  friendly_unresolved_deferreds = null;
  friendly_annotation_generator = null;

  function checkOpt(name) {
    return ((name in options) && !!options[name]);
  }

  if (checkOpt("unhandledRejections")) {
    trace_resolve = friendly_trace_resolve;
    if (typeof(options.unhandledRejections) === 'function')
      friendly_unhandled_rejection_handler = options.unhandledRejections;
    else if (options.unhandledRejections === 'log')
      friendly_unhandled_rejection_handler = console.error.bind(console);
    else
      friendly_unhandled_rejection_handler = friendly_throw;
  }
  if (checkOpt("exceptions")) {
    if (typeof(options.exceptions) === 'function')
      trace_exception = function(deferred, exception, where, value) {
        options.exceptions(exception, where);
      };
    else
      trace_exception = function(deferred, exception, where, value) {
        console.error("exception in '" + where + "'", exception);
      };
  }
  if (checkOpt("rejections")) {
    if (typeof(options.rejections) === 'function')
      trace_reject = function(deferred, reason, alreadyResolved) {
        options.rejections(reason, alreadyResolved);
      };
    else
      trace_reject = function(deferred, reason, alreadyResolved) {
        console.trace((alreadyResolved ? "already resolved " : "") +
          "rejection:", reason);
      };
  }
  if (checkOpt("trackLive")) {
    trace_defer = friendly_trace_defer;
    trace_resolve = friendly_trace_resolve;
    friendly_unresolved_deferreds = [];

    if (typeof(options.trackLive) === 'function')
      friendly_annotation_generator = options.trackLive;
  }
};

/**
 * Return the list of unresolved deferreds at this point.  Optionally, reset
 * clear the list so that these deferreds are not returned in the next call
 * to this function regardless of whether they become resolved or not.
 */
exports.friendlyUnresolvedDeferreds = function(reset) {
  var unresolvedAnnotations = [];
  for (var i = 0; i < friendly_unresolved_deferreds.length; i++) {
    unresolvedAnnotations.push(friendly_unresolved_deferreds[i].annotation);
  }
  if (reset)
    friendly_unresolved_deferreds = [];
  return unresolvedAnnotations;
};

////////////////////////////////////////////////////////////////////////////////
// Custom Logging Support

exports.loggingEnableCustom = function() {
};

////////////////////////////////////////////////////////////////////////////////


/**
 * Constructs a {promise, resolve} object.
 *
 * The resolver is a callback to invoke with a more resolved value for the
 * promise. To fulfill the promise, invoke the resolver with any value that is
 * not a function. To reject the promise, invoke the resolver with a rejection
 * object. To put the promise in the same state as another promise, invoke the
 * resolver with that other promise.
 */
exports.defer = defer;

function defer(annotation) {
    // if "pending" is an "Array", that indicates that the promise has not yet
    // been resolved.  If it is "undefined", it has been resolved.  Each
    // element of the pending array is itself an array of complete arguments to
    // forward to the resolved promise.  We coerce the resolution value to a
    // promise using the ref promise because it handles both fully
    // resolved values and other promises gracefully.
    var pending = [], value;

    var deferred = create(defer.prototype);
    var promise = create(Promise.prototype);

    promise.promiseSend = function () {
        var args = slice.call(arguments), trace_context;
        if (trace_send_issue)
            trace_context = trace_send_issue(deferred, value, args,
                                             promise.promiseSend);
        if (pending) {
            pending.push(args);
        } else {
            nextTick(function () {
                if (trace_before_run)
                    trace_before_run(trace_context, deferred, value, args);
                value.promiseSend.apply(value, args);
                if (trace_after_run)
                    trace_after_run(trace_context, deferred, value, args);
            });
        }
    };

    promise.valueOf = function () {
        if (pending)
            return promise;
        return value.valueOf();
    };

    var resolve = function (resolvedValue) {
        var i, ii, task, trace_context;
        if (!pending)
            return;
        value = ref(resolvedValue);
        if (trace_resolve)
            trace_context = trace_resolve(deferred, value, pending, resolve);
        reduce.call(pending, function (undefined, pending) {
            nextTick(function () {
                if (trace_before_run)
                    trace_before_run(trace_context, deferred, value);
                value.promiseSend.apply(value, pending);
                if (trace_after_run)
                    trace_after_run(trace_context, deferred, value);
            });
        }, void 0);
        pending = void 0;
        return value;
    };

    deferred.promise = freeze(promise);
    deferred.resolve = resolve;
    deferred.reject = function (reason) {
        if (trace_reject)
            trace_reject(deferred, reason, !pending);
        return resolve(reject(reason));
    };

    if (trace_defer)
        trace_defer(deferred, annotation);

    return deferred;
}

defer.prototype.node = function () {
    var self = this;
    return function (error, value) {
        if (error) {
            self.reject(error);
        } else if (arguments.length > 2) {
            self.resolve(Array.prototype.slice.call(arguments, 1));
        } else {
            self.resolve(value);
        }
    };
};

/**
 * Constructs a Promise with a promise descriptor object and optional fallback
 * function.  The descriptor contains methods like when(rejected), get(name),
 * put(name, value), post(name, args), and delete(name), which all
 * return either a value, a promise for a value, or a rejection.  The fallback
 * accepts the operation name, a resolver, and any further arguments that would
 * have been forwarded to the appropriate method above had a method been
 * provided with the proper name.  The API makes no guarantees about the nature
 * of the returned object, apart from that it is usable whereever promises are
 * bought and sold.
 */
exports.makePromise = Promise;
function Promise(descriptor, fallback, valueOf) {

    if (fallback === void 0) {
        fallback = function (op) {
            return reject("Promise does not support operation: " + op);
        };
    }

    var promise = create(Promise.prototype);

    promise.promiseSend = function (op, resolved /* ...args */) {
        var args = slice.call(arguments, 2);
        var result;
        try {
            if (descriptor[op]) {
                result = descriptor[op].apply(descriptor, args);
            } else {
                result = fallback.apply(descriptor, [op].concat(args));
            }
        } catch (exception) {
            if (trace_exception)
                trace_exception(deferred, exception, 'promiseSend', args);
            result = reject(exception);
        }
        return (resolved || identity)(result);
    };

    if (valueOf)
        promise.valueOf = valueOf;

    return freeze(promise);
};

// provide thenables, CommonJS/Promises/A
Promise.prototype.then = function (fulfilled, rejected) {
    return when(this, fulfilled, rejected);
};

// Chainable methods
reduce.call(
    [
        "when", "spread", "send",
        "get", "put", "del",
        "post", "invoke",
        "keys",
        "apply", "call",
        "all", "wait", "join",
        "fail", "fin",
        "view", "viewInfo",
        "timeout", "delay",
        "end"
    ],
    function (prev, name) {
        Promise.prototype[name] = function () {
            return exports[name].apply(
                exports,
                [this].concat(slice.call(arguments))
            );
        };
    },
    void 0
)

Promise.prototype.toSource = function () {
    return this.toString();
};

Promise.prototype.toString = function () {
    return '[object Promise]';
};

freeze(Promise.prototype);

/**
 * @returns whether the given object is a promise.
 * Otherwise it is a fulfilled value.
 */
exports.isPromise = isPromise;
function isPromise(object) {
    return object && typeof object.promiseSend === "function";
};

/**
 * @returns whether the given object is a resolved promise.
 */
exports.isResolved = isResolved;
function isResolved(object) {
    return !isPromise(valueOf(object));
};

/**
 * @returns whether the given object is a value or fulfilled
 * promise.
 */
exports.isFulfilled = isFulfilled;
function isFulfilled(object) {
    return !isPromise(valueOf(object)) && !isRejected(object);
};

/**
 * @returns whether the given object is a rejected promise.
 */
exports.isRejected = isRejected;
function isRejected(object) {
    object = valueOf(object);
    if (object === void 0 || object === null)
        return false;
    return !!object.promiseRejected;
}

/**
 * Constructs a rejected promise.
 * @param reason value describing the failure
 */
exports.reject = reject;
function reject(reason) {
    return Promise({
        "when": function (rejected) {
            return rejected ? rejected(reason) : reject(reason);
        }
    }, function fallback(op) {
        return reject(reason);
    }, function valueOf() {
        var rejection = create(reject.prototype);
        rejection.promiseRejected = true;
        rejection.reason = reason;
        return rejection;
    });
}

reject.prototype = create(Promise.prototype, {
    constructor: { value: reject }
});

/**
 * Constructs a promise for an immediate reference.
 * @param value immediate reference
 */
exports.ref = ref;
function ref(object) {
    // If the object is already a Promise, return it directly.  This enables
    // the ref function to both be used to created references from
    // objects, but to tolerably coerce non-promises to refs if they are
    // not already Promises.
    if (isPromise(object))
        return object;
    // assimilate thenables, CommonJS/Promises/A
    if (object && typeof object.then === "function") {
        var result = defer();
        object.then(result.resolve, result.reject);
        return result.promise;
    }
    return Promise({
        "when": function (rejected) {
            return object;
        },
        "get": function (name) {
            return object[name];
        },
        "put": function (name, value) {
            return object[name] = value;
        },
        "del": function (name) {
            return delete object[name];
        },
        "post": function (name, value) {
            return object[name].apply(object, value);
        },
        "apply": function (self, args) {
            return object.apply(self, args);
        },
        "viewInfo": function () {
            var on = object;
            var properties = {};
            while (on) {
                Object.getOwnPropertyNames(on).forEach(function (name) {
                    if (!properties[name])
                        properties[name] = typeof on[name];
                });
                on = Object.getPrototypeOf(on);
            }
            return {
                "type": typeof object,
                "properties": properties
            }
        },
        "keys": function () {
            return keys(object);
        }
    }, void 0, function valueOf() {
        return object;
    });
}

/**
 * Annotates an object such that it will never be
 * transferred away from this process over any promise
 * communication channel.
 * @param object
 * @returns promise a wrapping of that object that
 * additionally responds to the 'isDef' message
 * without a rejection.
 */
exports.master = master;
function master(object) {
    return Promise({
        "isDef": function () {}
    }, function fallback(op) {
        var args = slice.call(arguments);
        return send.apply(void 0, [object].concat(args));
    }, function () {
        return valueOf(object);
    });
}

exports.viewInfo = viewInfo;
function viewInfo(object, info) {
    object = ref(object);
    if (info) {
        return Promise({
            "viewInfo": function () {
                return info;
            }
        }, function fallback(op) {
            var args = slice.call(arguments);
            return send.apply(void 0, [object].concat(args));
        }, function () {
            return valueOf(object);
        });
    } else {
        return send(object, "viewInfo")
    }
}

exports.view = view;
function view(object) {
    return viewInfo(object).when(function (info) {
        var view;
        if (info.type === "function") {
            view = function () {
                return apply(object, void 0, arguments);
            };
        } else {
            view = {};
        }
        var properties = info.properties || {};
        Object.keys(properties).forEach(function (name) {
            if (properties[name] === "function") {
                view[name] = function () {
                    return post(object, name, arguments);
                };
            }
        });
        return ref(view);
    });
}

/**
 * Registers an observer on a promise.
 *
 * Guarantees:
 *
 * 1. that fulfilled and rejected will be called only once.
 * 2. that either the fulfilled callback or the rejected callback will be
 *    called, but not both.
 * 3. that fulfilled and rejected will not be called in this turn.
 *
 * @param value     promise or immediate reference to observe
 * @param fulfilled function to be called with the fulfilled value
 * @param rejected  function to be called with the rejection reason
 * @param progress  unused function to be called with progress updates
 * @param annotation an object to identify/name the created promise
 * @return promise for the return value from the invoked callback
 */
exports.when = when;
function when(value, fulfilled, rejected, progress, annotation) {
    var deferred = defer(annotation);
    var done = false;   // ensure the untrusted promise makes at most a
                        // single call to one of the callbacks

    function _fulfilled(value) {
        try {
            return fulfilled ? fulfilled(value) : value;
        } catch (exception) {
            if (trace_exception)
                trace_exception(deferred, exception, 'resolve', value);
            return reject(exception);
        }
    }

    function _rejected(reason) {
        try {
            return rejected ? rejected(reason) : reject(reason);
        } catch (exception) {
            if (trace_exception)
                trace_exception(deferred, exception, 'reject', reason);
            return reject(exception);
        }
    }

    nextTick(function () {
        ref(value).promiseSend("when", function (value) {
            if (done)
                return;
            done = true;
            deferred.resolve(
                ref(value)
                .promiseSend("when", _fulfilled, _rejected)
            );
        }, function (reason) {
            if (done)
                return;
            done = true;
            deferred.resolve(_rejected(reason));
        });
    });

    return deferred.promise;
}

exports.spread = spread;
function spread(promise, fulfilled, rejected) {
    return when(promise, function (values) {
        return fulfilled.apply(void 0, values);
    }, rejected);
}

/**
 * The async function is a decorator for generator functions, turning
 * them into asynchronous generators.  This presently only works in
 * Firefox/Spidermonkey, however, this code does not cause syntax
 * errors in older engines.  This code should continue to work and
 * will in fact improve over time as the language improves.
 *
 * Decorates a generator function such that:
 *  - it may yield promises
 *  - execution will continue when that promise is fulfilled
 *  - the value of the yield expression will be the fulfilled value
 *  - it returns a promise for the return value (when the generator
 *    stops iterating)
 *  - the decorated function returns a promise for the return value
 *    of the generator or the first rejected promise among those
 *    yielded.
 *  - if an error is thrown in the generator, it propagates through
 *    every following yield until it is caught, or until it escapes
 *    the generator function altogether, and is translated into a
 *    rejection for the promise returned by the decorated generator.
 *  - in present implementations of generators, when a generator
 *    function is complete, it throws ``StopIteration``, ``return`` is
 *    a syntax error in the presence of ``yield``, so there is no
 *    observable return value. There is a proposal[1] to add support
 *    for ``return``, which would permit the value to be carried by a
 *    ``StopIteration`` instance, in which case it would fulfill the
 *    promise returned by the asynchronous generator.  This can be
 *    emulated today by throwing StopIteration explicitly with a value
 *    property.
 *
 *  [1]: http://wiki.ecmascript.org/doku.php?id=strawman:async_functions#reference_implementation
 *
 */
exports.async = async;
function async(makeGenerator) {
    return function () {
        // when verb is "send", arg is a value
        // when verb is "throw", arg is a reason/error
        var continuer = function (verb, arg) {
            var result;
            try {
                result = generator[verb](arg);
            } catch (exception) {
                if (isStopIteration(exception)) {
                    return exception.value;
                } else {
                    return reject(exception);
                }
            }
            return when(result, callback, errback);
        };
        var generator = makeGenerator.apply(this, arguments);
        var callback = continuer.bind(continuer, "send");
        var errback = continuer.bind(continuer, "throw");
        return callback();
    };
}

/**
 * Constructs a promise method that can be used to safely observe resolution of
 * a promise for an arbitrarily named method like "propfind" in a future turn.
 *
 * "Method" constructs methods like "get(promise, name)" and "put(promise)".
 */
exports.Method = Method;
function Method (op) {
    return function (object) {
        var args = slice.call(arguments, 1);
        return send.apply(void 0, [object, op].concat(args));
    };
}

/**
 * sends a message to a value in a future turn
 * @param object* the recipient
 * @param op the name of the message operation, e.g., "when",
 * @param ...args further arguments to be forwarded to the operation
 * @returns result {Promise} a promise for the result of the operation
 */
exports.send = send;
function send(object, op) {
    var deferred = defer();
    var args = slice.call(arguments, 2);
    object = ref(object);
    nextTick(function () {
        object.promiseSend.apply(
            object,
            [op, deferred.resolve].concat(args)
        );
    });
    return deferred.promise;
}

/**
 * Gets the value of a property in a future turn.
 * @param object    promise or immediate reference for target object
 * @param name      name of property to get
 * @return promise for the property value
 */
exports.get = Method("get");

/**
 * Sets the value of a property in a future turn.
 * @param object    promise or immediate reference for object object
 * @param name      name of property to set
 * @param value     new value of property
 * @return promise for the return value
 */
exports.put = Method("put");

/**
 * Deletes a property in a future turn.
 * @param object    promise or immediate reference for target object
 * @param name      name of property to delete
 * @return promise for the return value
 */
exports.del = Method("del");

/**
 * Invokes a method in a future turn.
 * @param object    promise or immediate reference for target object
 * @param name      name of method to invoke
 * @param value     a value to post, typically an array of
 *                  invocation arguments for promises that
 *                  are ultimately backed with `ref` values,
 *                  as opposed to those backed with URLs
 *                  wherein the posted value can be any
 *                  JSON serializable object.
 * @return promise for the return value
 */
var post = exports.post = Method("post");

/**
 * Invokes a method in a future turn.
 * @param object    promise or immediate reference for target object
 * @param name      name of method to invoke
 * @param ...args   array of invocation arguments
 * @return promise for the return value
 */
exports.invoke = function (value, name) {
    var args = slice.call(arguments, 2);
    return post(value, name, args);
};

/**
 * Applies the promised function in a future turn.
 * @param object    promise or immediate reference for target function
 * @param context   the context object (this) for the call
 * @param args      array of application arguments
 */
var apply = exports.apply = Method("apply");

/**
 * Calls the promised function in a future turn.
 * @param object    promise or immediate reference for target function
 * @param context   the context object (this) for the call
 * @param ...args   array of application arguments
 */
var call = exports.call = function (value, context) {
    var args = slice.call(arguments, 2);
    return apply(value, context, args);
};

/**
 * Requests the names of the owned properties of a promised
 * object in a future turn.
 * @param object    promise or immediate reference for target object
 * @return promise for the keys of the eventually resolved object
 */
exports.keys = Method("keys");

/**
 * Turns an array of promises into a promise for an array.  If any of
 * the promises gets rejected, the whole array is rejected immediately.
 * @param {Array*} an array (or promise for an array) of values (or
 * promises for values)
 * @returns a promise for an array of the corresponding values
 */
// By Mark Miller
// http://wiki.ecmascript.org/doku.php?id=strawman:concurrency&rev=1308776521#allfulfilled
exports.all = all;
function all(promises, annotation) {
    return when(promises, function (promises) {
        var countDown = promises.length;
        if (countDown === 0)
            return ref(promises);
        var deferred = defer(annotation);
        reduce.call(promises, function (undefined, promise, index) {
            when(promise, function (value) {
                promises[index] = value;
                if (--countDown === 0)
                    deferred.resolve(promises);
            }, void 0, void 0, "Q:all")
            .fail(deferred.reject);
        }, void 0);
        return deferred.promise;
    });
}

/**
 * Captures the failure of a promise, giving an oportunity to recover
 * with a callback.  If the given promise is fulfilled, the returned
 * promise is fulfilled.
 * @param {Any*} promise for something
 * @param {Function} callback to fulfill the returned promise if the
 * given promise is rejected
 * @returns a promise for the return value of the callback
 */
exports.fail = fail;
function fail(promise, rejected) {
    return when(promise, void 0, rejected, void 0, "Q:fail");
}

/**
 * Provides an opportunity to observe the rejection of a promise,
 * regardless of whether the promise is fulfilled or rejected.  Forwards
 * the resolution to the returned promise when the callback is done.
 * The callback can return a promise to defer completion.
 * @param {Any*} promise
 * @param {Function} callback to observe the resolution of the given
 * promise, takes no arguments.
 * @returns a promise for the resolution of the given promise when
 * ``fin`` is done.
 */
exports.fin = fin;
function fin(promise, callback) {
    return when(promise, function (value) {
        return when(callback(), function () {
            return value;
        });
    }, function (reason) {
        return when(callback(), function () {
            return reject(reason);
        });
    });
}

/**
 * Terminates a chain of promises, forcing rejections to be
 * thrown as exceptions.
 * @param {Any*} promise at the end of a chain of promises
 * @returns nothing
 */
exports.end = end;
function end(promise) {
    when(promise, void 0, function (error) {
        // forward to a future turn so that ``when``
        // does not catch it and turn it into a rejection.
        nextTick(function () {
            throw error;
        });
    });
}

/**
 * Causes a promise to be rejected if it does not get fulfilled before
 * some milliseconds time out.
 * @param {Any*} promise
 * @param {Number} milliseconds timeout
 * @returns a promise for the resolution of the given promise if it is
 * fulfilled before the timeout, otherwise rejected.
 */
exports.timeout = timeout;
function timeout(promise, timeout) {
    var deferred = defer();
    when(promise, deferred.resolve, deferred.reject);
    setTimeout(function () {
        deferred.reject("Timed out");
    }, timeout);
    return deferred.promise;
}

/**
 * Returns a promise for the given value (or promised value) after some
 * milliseconds.
 * @param {Any*} promise
 * @param {Number} milliseconds
 * @returns a promise for the resolution of the given promise after some
 * time has elapsed.
 */
exports.delay = delay;
function delay(promise, timeout) {
    if (timeout === void 0) {
        timeout = promise;
        promise = void 0;
    }
    var deferred = defer();
    setTimeout(function () {
        deferred.resolve(promise);
    }, timeout);
    return deferred.promise;
}

/**
 * Wraps a NodeJS continuation passing function and returns an equivalent
 * version that returns a promise.
 *
 *      Q.node(FS.readFile)(__filename)
 *      .then(console.log)
 *      .end()
 *
 */
exports.node = node;
function node(callback /* thisp, ...args*/) {
    if (arguments.length > 1) {
        var args = Array.prototype.slice.call(arguments, 1);
        callback = callback.bind.apply(callback, args);
    }
    return function () {
        var deferred = defer();
        var args = slice.call(arguments);
        // add a continuation that resolves the promise
        args.push(deferred.node());
        // trap exceptions thrown by the callback
        apply(callback, this, args)
        .fail(deferred.reject);
        return deferred.promise;
    };
}

/**
 * Passes a continuation to a Node function and returns a promise.
 *
 *      var FS = require("fs");
 *      Q.ncall(FS.readFile, __filename)
 *      .then(function (content) {
 *      })
 *
 */
exports.ncall = ncall;
function ncall(callback, thisp /*, ...args*/) {
    var args = slice.call(arguments, 2);
    return node(callback).apply(thisp, args);
}

});
