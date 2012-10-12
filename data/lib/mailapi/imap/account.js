/**
 *
 **/

define(
  [
    'imap',
    'rdcommon/log',
    '../a64',
    '../errbackoff',
    '../mailslice',
    '../searchfilter',
    '../util',
    './folder',
    './jobs',
    'module',
    'exports'
  ],
  function(
    $imap,
    $log,
    $a64,
    $errbackoff,
    $mailslice,
    $searchfilter,
    $util,
    $imapfolder,
    $imapjobs,
    $module,
    exports
  ) {
const bsearchForInsert = $util.bsearchForInsert;

function cmpFolderPubPath(a, b) {
  return a.path.localeCompare(b.path);
}

/**
 * Account object, root of all interaction with servers.
 *
 * Passwords are currently held in cleartext with the rest of the data.  Ideally
 * we would like them to be stored in some type of keyring coupled to the TCP
 * API in such a way that we never know the API.  Se a vida e.
 *
 */
function ImapAccount(universe, compositeAccount, accountId, credentials,
                     connInfo, folderInfos,
                     dbConn,
                     _parentLog, existingProtoConn) {
  this.universe = universe;
  this.compositeAccount = compositeAccount;
  this.id = accountId;

  this._LOG = LOGFAB.ImapAccount(this, _parentLog, this.id);

  this._credentials = credentials;
  this._connInfo = connInfo;
  this._db = dbConn;

  /**
   * The maximum number of connections we are allowed to have alive at once.  We
   * want to limit this both because we generally aren't sophisticated enough
   * to need to use many connections at once (unless we have bugs), and because
   * servers may enforce a per-account connection limit which can affect both
   * us and other clients on other devices.
   *
   * Thunderbird's default for this is 5.
   *
   * gmail currently claims to have a limit of 10 connections per account:
   * http://support.google.com/mail/bin/answer.py?hl=en&answer=97150
   *
   * I am picking 3 right now because it should cover the "I just sent a
   * messages from the folder I was in and then switched to another folder",
   * where we could have stuff to do in the old folder, new folder, and sent
   * mail folder.  I have also seem claims of connection limits of 3 for some
   * accounts out there, so this avoids us needing logic to infer a need to
   * lower our connection limit.
   */
  this._maxConnsAllowed = 3;
  /**
   * The `ImapConnection` we are attempting to open, if any.  We only try to
   * open one connection at a time.
   */
  this._pendingConn = null;
  this._ownedConns = [];
  /**
   * @listof[@dict[
   *   @key[folderId]
   *   @key[callback]
   * ]]{
   *   The list of requested connections that have not yet been serviced.  An
   * }
   */
  this._demandedConns = [];
  this._backoffEndpoint = $errbackoff.createEndpoint('imap:' + this.id, this,
                                                     this._LOG);
  this._boundMakeConnection = this._makeConnection.bind(this);

  this._jobDriver = new $imapjobs.ImapJobDriver(this);

  if (existingProtoConn)
    this._reuseConnection(existingProtoConn);

  // Yes, the pluralization is suspect, but unambiguous.
  /** @dictof[@key[FolderId] @value[ImapFolderStorage] */
  var folderStorages = this._folderStorages = {};
  /** @dictof[@key[FolderId] @value[ImapFolderMeta] */
  var folderPubs = this.folders = [];

  /**
   * The list of dead folder id's that we need to nuke the storage for when
   * we next save our account status to the database.
   */
  this._deadFolderIds = null;

  /**
   * The canonical folderInfo object we persist to the database.
   */
  this._folderInfos = folderInfos;
  /**
   * @dict[
   *   @param[nextFolderNum Number]{
   *     The next numeric folder number to be allocated.
   *   }
   *   @param[nextMutationNum Number]{
   *     The next mutation id to be allocated.
   *   }
   *   @param[lastFullFolderProbeAt DateMS]{
   *     When was the last time we went through our list of folders and got the
   *     unread count in each folder.
   *   }
   *   @param[capability @listof[String]]{
   *     The post-login capabilities from the server.
   *   }
   *   @param[rootDelim String]{
   *     The root hierarchy delimiter.  It is possible for servers to not
   *     support hierarchies, but we just declare that those servers are not
   *     acceptable for use.
   *   }
   * ]{
   *   Meta-information about the account derived from probing the account.
   *   This information gets flushed on database upgrades.
   * }
   */
  this.meta = this._folderInfos.$meta;
  /**
   * @listof[SerializedMutation]{
   *   The list of recently issued mutations against us.  Mutations are added
   *   as soon as they are requested and remain until evicted based on a hard
   *   numeric limit.  The limit is driven by our unit tests rather than our
   *   UI which currently only allows a maximum of 1 (high-level) undo.  The
   *   status of whether the mutation has been run is tracked on the mutation
   *   but does not affect its presence or position in the list.
   *
   *   Right now, the `MailUniverse` is in charge of this and we just are a
   *   convenient place to stash the data.
   * }
   */
  this.mutations = this._folderInfos.$mutations;
  this.deferredMutations = this._folderInfos.$deferredMutations;
  for (var folderId in folderInfos) {
    if (folderId[0] === '$')
      continue;
    var folderInfo = folderInfos[folderId];

    folderStorages[folderId] =
      new $mailslice.FolderStorage(this, folderId, folderInfo, this._db,
                                   $imapfolder.ImapFolderSyncer, this._LOG);
    folderPubs.push(folderInfo.$meta);
  }
  this.folders.sort(function(a, b) {
    return a.path.localeCompare(b.path);
  });
}
exports.ImapAccount = ImapAccount;
ImapAccount.prototype = {
  type: 'imap',
  toString: function() {
    return '[ImapAccount: ' + this.id + ']';
  },

  /**
   * Make a given folder known to us, creating state tracking instances, etc.
   */
  _learnAboutFolder: function(name, path, type, delim, depth) {
    var folderId = this.id + '/' + $a64.encodeInt(this.meta.nextFolderNum++);
    var folderInfo = this._folderInfos[folderId] = {
      $meta: {
        id: folderId,
        name: name,
        path: path,
        type: type,
        delim: delim,
        depth: depth
      },
      $impl: {
        nextHeaderBlock: 0,
        nextBodyBlock: 0,
      },
      accuracy: [],
      headerBlocks: [],
      bodyBlocks: [],
    };
    this._folderStorages[folderId] =
      new $mailslice.FolderStorage(this, folderId, folderInfo, this._db,
                                   $imapfolder.ImapFolderSyncer, this._LOG);

    var folderMeta = folderInfo.$meta;
    var idx = bsearchForInsert(this.folders, folderMeta, cmpFolderPubPath);
    this.folders.splice(idx, 0, folderMeta);

    this.universe.__notifyAddedFolder(this.id, folderMeta);
    return folderMeta;
  },

  _forgetFolder: function(folderId) {
    var folderInfo = this._folderInfos[folderId],
        folderMeta = folderInfo.$meta;
    delete this._folderInfos[folderId];
    var folderStorage = this._folderStorages[folderId];
    delete this._folderStorages[folderId];
    var idx = this.folders.indexOf(folderMeta);
    this.folders.splice(idx, 1);
    if (this._deadFolderIds === null)
      this._deadFolderIds = [];
    this._deadFolderIds.push(folderId);
    folderStorage.youAreDeadCleanupAfterYourself();

    this.universe.__notifyRemovedFolder(this.id, folderMeta);
  },

  /**
   * We are being told that a synchronization pass completed, and that we may
   * want to consider persisting our state.
   */
  __checkpointSyncCompleted: function() {
    this.saveAccountState();
  },

  /**
   * Save the state of this account to the database.  This entails updating all
   * of our highly-volatile state (folderInfos which contains counters, accuracy
   * structures, and our block info structures) as well as any dirty blocks.
   *
   * This should be entirely coherent because the structured clone should occur
   * synchronously during this call, but it's important to keep in mind that if
   * that ever ends up not being the case that we need to cause mutating
   * operations to defer until after that snapshot has occurred.
   */
  saveAccountState: function(reuseTrans) {
    var perFolderStuff = [], self = this;
    for (var iFolder = 0; iFolder < this.folders.length; iFolder++) {
      var folderPub = this.folders[iFolder],
          folderStorage = this._folderStorages[folderPub.id],
          folderStuff = folderStorage.generatePersistenceInfo();
      if (folderStuff)
        perFolderStuff.push(folderStuff);
    }
    this._LOG.saveAccountState_begin();
    var trans = this._db.saveAccountFolderStates(
      this.id, this._folderInfos, perFolderStuff,
      this._deadFolderIds,
      function stateSaved() {
        self._LOG.saveAccountState_end();
      },
      reuseTrans);
    this._deadFolderIds = null;
    return trans;
  },

  /**
   * Delete an existing folder WITHOUT ANY ABILITY TO UNDO IT.  Current UX
   * does not desire this, but the unit tests do.
   *
   * Callback is like the createFolder one, why not.
   */
  deleteFolder: function(folderId, callback) {
    if (!this._folderInfos.hasOwnProperty(folderId))
      throw new Error("No such folder: " + folderId);

    if (!this.universe.online) {
      callback('offline');
      return;
    }

    var folderMeta = this._folderInfos[folderId].$meta;

    var rawConn = null, self = this;
    function gotConn(conn) {
      rawConn = conn;
      rawConn.delBox(folderMeta.path, deletionCallback);
    }
    function deletionCallback(err) {
      if (err)
        done('unknown');
      else
        done(null);
    }
    function done(errString) {
      if (rawConn) {
        self.__folderDoneWithConnection(rawConn, false, false);
        rawConn = null;
      }
      if (!errString) {
        self._LOG.deleteFolder(folderMeta.path);
        self._forgetFolder(folderId);
      }
      if (callback)
        callback(errString, folderMeta);
    }
    this.__folderDemandsConnection(null, 'deleteFolder', gotConn);
  },

  getFolderStorageForFolderId: function(folderId) {
    if (this._folderStorages.hasOwnProperty(folderId))
      return this._folderStorages[folderId];
    throw new Error('No folder with id: ' + folderId);
  },

  getFolderStorageForMessageSuid: function(messageSuid) {
    var folderId = messageSuid.substring(0, messageSuid.lastIndexOf('/'));
    if (this._folderStorages.hasOwnProperty(folderId))
      return this._folderStorages[folderId];
    throw new Error('No folder with id: ' + folderId);
  },

  /**
   * Create a view slice on the messages in a folder, starting from the most
   * recent messages and synchronizing further as needed.
   */
  sliceFolderMessages: function(folderId, bridgeHandle) {
    var storage = this._folderStorages[folderId],
        slice = new $mailslice.MailSlice(bridgeHandle, storage, this._LOG);

    storage.sliceOpenFromNow(slice);
  },

  searchFolderMessages: function(folderId, bridgeHandle, phrase, whatToSearch) {
    var storage = this._folderStorages[folderId],
        slice = new $searchfilter.SearchSlice(bridgeHandle, storage, phrase,
                                              whatToSearch, this._LOG);
    // the slice is self-starting, we don't need to call anything on storage
  },

  shutdown: function() {
    // - kill all folder storages (for their loggers)
    for (var iFolder = 0; iFolder < this.folders.length; iFolder++) {
      var folderPub = this.folders[iFolder],
          folderStorage = this._folderStorages[folderPub.id];
      folderStorage.shutdown();
    }

    this._backoffEndpoint.shutdown();

    // - close all connections
    for (var i = 0; i < this._ownedConns.length; i++) {
      var connInfo = this._ownedConns[i];
      connInfo.conn.die();
    }

    this._LOG.__die();
  },

  checkAccount: function(listener) {
    var self = this;
    this._makeConnection(listener, null, 'check');
  },

  //////////////////////////////////////////////////////////////////////////////
  // Connection Pool-ish stuff

  get numActiveConns() {
    return this._ownedConns.length;
  },

  /**
   * Mechanism for an `ImapFolderConn` to request an IMAP protocol connection.
   * This is to potentially support some type of (bounded) connection pooling
   * like Thunderbird uses.  The rationale is that many servers cap the number
   * of connections we are allowed to maintain, plus it's hard to justify
   * locally tying up those resources.  (Thunderbird has more need of watching
   * multiple folders than ourselves, bu we may still want to synchronize a
   * bunch of folders in parallel for latency reasons.)
   *
   * The provided connection will *not* be in the requested folder; it's up to
   * the folder connection to enter the folder.
   *
   * @args[
   *   @param[folderId #:optional FolderId]{
   *     The folder id of the folder that will be using the connection.  If
   *     it's not a folder but some task, then pass null (and ideally provide
   *     a useful `label`).
   *   }
   *   @param[label #:optional String]{
   *     A human readable explanation of the activity for debugging purposes.
   *   }
   *   @param[callback @func[@args[@param[conn]]]]{
   *     The callback to invoke once the connection has been established.  If
   *     there is a connection present in the reuse pool, this may be invoked
   *     immediately.
   *   }
   *   @param[deathback Function]{
   *     A callback to invoke if the connection dies or we feel compelled to
   *     reclaim it.
   *   }
   * ]
   */
  __folderDemandsConnection: function(folderId, label, callback, deathback) {
    this._demandedConns.push({
      folderId: folderId,
      label: label,
      callback: callback,
      deathback: deathback
    });

    // No line-cutting; bail if there was someone ahead of us.
    if (this._demandedConns.length > 1)
      return;

    // - try and reuse an existing connection
    if (this._allocateExistingConnection())
      return;

    // - we need to wait for a new conn or one to free up
    this._makeConnectionIfPossible();
  },

  _allocateExistingConnection: function() {
    if (!this._demandedConns.length)
      return false;
    var demandInfo = this._demandedConns[0];

    var reusableConnInfo = null;
    for (var i = 0; i < this._ownedConns.length; i++) {
      var connInfo = this._ownedConns[i];
      // It's concerning if the folder already has a connection...
      if (demandInfo.folderId && connInfo.folderId === demandInfo.folderId)
        this._LOG.folderAlreadyHasConn(demandInfo.folderId);

      if (connInfo.inUseBy)
        continue;

      connInfo.inUseBy = demandInfo;
      this._demandedConns.shift();
      this._LOG.reuseConnection(demandInfo.folderId, demandInfo.label);
      demandInfo.callback(connInfo.conn);
      return true;
    }

    return false;
  },

  /**
   * Close all connections that aren't currently in use.
   */
  closeUnusedConnections: function() {
    for (var i = this._ownedConns.length - 1; i >= 0; i--) {
      var connInfo = this._ownedConns[i];
      if (connInfo.inUseBy)
        continue;
      // this eats all future notifications, so we need to splice...
      connInfo.conn.die();
      this._ownedConns.splice(i, 1);
      this._LOG.deadConnection();
    }
  },

  _makeConnectionIfPossible: function() {
    if (this._ownedConns.length >= this._maxConnsAllowed) {
      this._LOG.maximumConnsNoNew();
      return;
    }
    if (this._pendingConn)
      return;

    this._pendingConn = true;
    this._backoffEndpoint.scheduleConnectAttempt(this._boundMakeConnection);
  },

  _makeConnection: function(listener, whyFolderId, whyLabel) {
    this._LOG.createConnection(whyFolderId, whyLabel);
    var opts = {
      host: this._connInfo.hostname,
      port: this._connInfo.port,
      crypto: this._connInfo.crypto,

      username: this._credentials.username,
      password: this._credentials.password,
    };
    if (this._LOG) opts._logParent = this._LOG;
    var conn = this._pendingConn = new $imap.ImapConnection(opts);
    var connectCallbackTriggered = false;
    // The login callback should get invoked in all cases, but a recent code
    // inspection for the prober suggested that there may be some cases where
    // things might fall-through, so let's just convert them.  We need some
    // type of handler since imap.js currently calls the login callback and
    // then the 'error' handler, generating an error if there is no error
    // handler.
    conn.on('error', function(err) {
      if (!connectCallbackTriggered)
        loginCb(err);
    });
    var loginCb;
    conn.connect(loginCb = function(err) {
      connectCallbackTriggered = true;
      this._pendingConn = null;
      if (err) {
        var errName, reachable = false, maybeRetry = true;
        // We want to produce error-codes as defined in `MailApi.js` for
        // tryToCreateAccount.  We have also tried to make imap.js produce
        // error codes of the right type already, but for various generic paths
        // (like saying 'NO'), there isn't currently a good spot for that.
        switch (err.type) {
          // dovecot says after a delay and does not terminate the connection:
          //   NO [AUTHENTICATIONFAILED] Authentication failed.
          // zimbra 7.2.x says after a delay and DOES terminate the connection:
          //   NO LOGIN failed
          //   * BYE Zimbra IMAP server terminating connection
          // yahoo says after a delay and does not terminate the connection:
          //   NO [AUTHENTICATIONFAILED] Incorrect username or password.
          case 'NO':
          case 'no':
            errName = 'bad-user-or-pass';
            reachable = true;
            // go directly to the broken state; no retries
            maybeRetry = false;
            // tell the higher level to disable our account until we fix our
            // credentials problem and ideally generate a UI prompt.
            this.universe.__reportAccountProblem(this.compositeAccount,
                                                 errName);
            break;
          // errors we can pass through directly:
          case 'server-maintenance':
            errName = err.type;
            reachable = true;
            break;
          case 'timeout':
            errName = 'unresponsive-server';
            break;
          default:
            errName = 'unknown';
            break;
        }
        console.error('Connect error:', errName, 'formal:', err, 'on',
                      this._connInfo.hostname, this._connInfo.port);
        if (listener)
          listener(errName);
        conn.die();

        // track this failure for backoff purposes
        if (maybeRetry) {
          if (this._backoffEndpoint.noteConnectFailureMaybeRetry(reachable))
            this._makeConnectionIfPossible();
        }
        else {
          this._backoffEndpoint.noteBrokenConnection();
        }
      }
      else {
        this._bindConnectionDeathHandlers(conn);
        this._backoffEndpoint.noteConnectSuccess();
        this._ownedConns.push({
          conn: conn,
          inUseBy: null,
        });
        this._allocateExistingConnection();
        if (listener)
          listener(null);
        // Keep opening connections if there is more work to do (and possible).
        if (this._demandedConns.length)
          this._makeConnectionIfPossible();
      }
    }.bind(this));
  },

  /**
   * Treat a connection that came from the IMAP prober as a connection we
   * created ourselves.
   */
  _reuseConnection: function(existingProtoConn) {
    // We don't want the probe being kept alive and we certainly don't need its
    // listeners.
    existingProtoConn.removeAllListeners();
    this._ownedConns.push({
        conn: existingProtoConn,
        inUseBy: null,
      });
    this._bindConnectionDeathHandlers(existingProtoConn);
  },

  _bindConnectionDeathHandlers: function(conn) {
    // on close, stop tracking the connection in our list of live connections
    conn.on('close', function() {
      for (var i = 0; i < this._ownedConns.length; i++) {
        var connInfo = this._ownedConns[i];
        if (connInfo.conn === conn) {
          this._LOG.deadConnection(connInfo.inUseBy &&
                                   connInfo.inUseBy.folderId);
          if (connInfo.inUseBy && connInfo.inUseBy.deathback)
            connInfo.inUseBy.deathback(conn);
          connInfo.inUseBy = null;
          this._ownedConns.splice(i, 1);
          return;
        }
      }
      this._LOG.unknownDeadConnection();
    }.bind(this));
    conn.on('error', function(err) {
      this._LOG.connectionError(err);
      // this hears about connection errors too
      console.warn('Conn steady error:', err, 'on',
                   this._connInfo.hostname, this._connInfo.port);
    }.bind(this));
  },

  __folderDoneWithConnection: function(conn, closeFolder, resourceProblem) {
    for (var i = 0; i < this._ownedConns.length; i++) {
      var connInfo = this._ownedConns[i];
      if (connInfo.conn === conn) {
        if (resourceProblem)
          this._backoffEndpoint(connInfo.inUseBy.folderId);
        this._LOG.releaseConnection(connInfo.inUseBy.folderId,
                                    connInfo.inUseBy.label);
        connInfo.inUseBy = null;
        // (this will trigger an expunge if not read-only...)
        if (closeFolder && !resourceProblem)
          conn.closeBox(function() {});
        return;
      }
    }
    this._LOG.connectionMismatch();
  },

  //////////////////////////////////////////////////////////////////////////////
  // Folder synchronization

  syncFolderList: function(callback) {
    var self = this;
    this.__folderDemandsConnection(null, 'syncFolderList', function(conn) {
      conn.getBoxes(self._syncFolderComputeDeltas.bind(self, conn, callback));
    });
  },
  _determineFolderType: function(box, path) {
    var type = null;
    // NoSelect trumps everything.
    if (box.attribs.indexOf('NOSELECT') !== -1) {
      type = 'nomail';
    }
    else {
      // Standards-ish:
      // - special-use: http://tools.ietf.org/html/rfc6154
      //   IANA registrations:
      //   http://www.iana.org/assignments/imap4-list-extended
      // - xlist:
      //   https://developers.google.com/google-apps/gmail/imap_extensions

      // Process the attribs for goodness.
      for (var i = 0; i < box.attribs.length; i++) {
        switch (box.attribs[i]) {
          case 'ALL': // special-use
          case 'ALLMAIL': // xlist
          case 'ARCHIVE': // special-use
            type = 'archive';
            break;
          case 'DRAFTS': // special-use xlist
            type = 'drafts';
            break;
          case 'FLAGGED': // special-use
            type = 'starred';
            break;
          case 'INBOX': // xlist
            type = 'inbox';
            break;
          case 'JUNK': // special-use
            type = 'junk';
            break;
          case 'SENT': // special-use xlist
            type = 'sent';
            break;
          case 'SPAM': // xlist
            type = 'junk';
            break;
          case 'STARRED': // xlist
            type = 'starred';
            break;

          case 'TRASH': // special-use xlist
            type = 'trash';
            break;

          case 'HASCHILDREN': // 3348
          case 'HASNOCHILDREN': // 3348

          // - standard bits we don't care about
          case 'MARKED': // 3501
          case 'UNMARKED': // 3501
          case 'NOINFERIORS': // 3501
            // XXX use noinferiors to prohibit folder creation under it.
          // NOSELECT

          default:
        }
      }

      // heuristic based type assignment based on the name
      if (!type) {
        switch (path.toUpperCase()) {
          case 'DRAFT':
          case 'DRAFTS':
            type = 'drafts';
            break;
          case 'INBOX':
            type = 'inbox';
            break;
          case 'JUNK':
          case 'SPAM':
            type = 'junk';
            break;
          case 'SENT':
            type = 'sent';
            break;
          case 'TRASH':
            type = 'trash';
            break;
        }
      }

      if (!type)
        type = 'normal';
    }
    return type;
  },
  _syncFolderComputeDeltas: function(conn, callback, err, boxesRoot) {
    var self = this;
    if (err) {
      // XXX need to deal with transient failure states
      this.__folderDoneWithConnection(conn, false, false);
      callback();
      return;
    }

    // - build a map of known existing folders
    var folderPubsByPath = {}, folderPub;
    for (var iFolder = 0; iFolder < this.folders.length; iFolder++) {
      folderPub = this.folders[iFolder];
      folderPubsByPath[folderPub.path] = folderPub;
    }

    // - walk the boxes
    function walkBoxes(boxLevel, pathSoFar, pathDepth) {
      for (var boxName in boxLevel) {
        var box = boxLevel[boxName],
            path = pathSoFar ? (pathSoFar + boxName) : boxName;

        // - already known folder
        if (folderPubsByPath.hasOwnProperty(path)) {
          // mark it with true to show that we've seen it.
          folderPubsByPath = true;
        }
        // - new to us!
        else {
          var type = self._determineFolderType(box, path);
          self._learnAboutFolder(boxName, path, type, box.delim, pathDepth);
        }

        if (box.children)
          walkBoxes(box.children, pathSoFar + boxName + box.delim,
                    pathDepth + 1);
      }
    }
    walkBoxes(boxesRoot, '', 0);

    // - detect deleted folders
    // track dead folder id's so we can issue a
    var deadFolderIds = [];
    for (var folderPath in folderPubsByPath) {
      folderPub = folderPubsByPath[folderPath];
      // (skip those we found above)
      if (folderPub === true)
        continue;
      // It must have gotten deleted!
      this._forgetFolder(folderPub.id);
    }

    this.__folderDoneWithConnection(conn, false, false);
    // be sure to save our state now that we are up-to-date on this.
    this.saveAccountState();
    callback();
  },

  //////////////////////////////////////////////////////////////////////////////

  /**
   * @args[
   *   @param[op MailOp]
   *   @param[mode @oneof[
   *     @case['local_do']{
   *       Apply the mutation locally to our database rep.
   *     }
   *     @case['check']{
   *       Check if the manipulation has been performed on the server.  There
   *       is no need to perform a local check because there is no way our
   *       database can be inconsistent in its view of this.
   *     }
   *     @case['do']{
   *       Perform the manipulation on the server.
   *     }
   *     @case['local_undo']{
   *       Undo the mutation locally.
   *     }
   *     @case['undo']{
   *       Undo the mutation on the server.
   *     }
   *   ]]
   *   @param[callback @func[
   *     @args[
   *       @param[error @oneof[String null]]
   *     ]
   *   ]]
   *   }
   * ]
   */
  runOp: function(op, mode, callback) {
    var methodName = mode + '_' + op.type, self = this,
        isLocal = (mode === 'local_do' || mode === 'local_undo');

    if (!(methodName in this._jobDriver))
      throw new Error("Unsupported op: '" + op.type + "' (mode: " + mode + ")");

    if (!isLocal)
      op.status = mode + 'ing';

    if (callback) {
      this._LOG.runOp_begin(mode, op.type, null, op);
      this._jobDriver[methodName](op, function(error, resultIfAny,
                                               accountSaveSuggested) {
        self._jobDriver.postJobCleanup();
        self._LOG.runOp_end(mode, op.type, error, op);
        callback(error, resultIfAny, accountSaveSuggested);
      });
    }
    else {
      this._LOG.runOp_begin(mode, op.type, null, null);
      var rval = this._jobDriver[methodName](op);
      this._jobDriver.postJobCleanup();
      this._LOG.runOp_end(mode, op.type, rval, op);
    }
  },

  // NB: this is not final mutation logic; it needs to be more friendly to
  // ImapFolderConn's.  See _do_modtags which is being cleaned up...
};

/**
 * While gmail deserves major props for providing any IMAP interface, everyone
 * is much better off if we treat it specially.  EVENTUALLY.
 */
function GmailAccount() {
}
GmailAccount.prototype = {
  type: 'gmail-imap',

};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  ImapAccount: {
    type: $log.ACCOUNT,
    events: {
      createFolder: {},
      deleteFolder: {},

      createConnection: {},
      reuseConnection: {},
      releaseConnection: {},
      deadConnection: {},
      connectionMismatch: {},

      /**
       * The maximum connection limit has been reached, we are intentionally
       * not creating an additional one.
       */
      maximumConnsNoNew: {},
    },
    TEST_ONLY_events: {
      deleteFolder: { path: false },

      createConnection: { folderId: false, label: false },
      reuseConnection: { folderId: false, label: false },
      releaseConnection: { folderId: false, label: false },
      deadConnection: { folderId: false },
      connectionMismatch: {},
    },
    errors: {
      unknownDeadConnection: {},
      connectionError: {},
      folderAlreadyHasConn: { folderId: false },
    },
    asyncJobs: {
      runOp: { mode: true, type: true, error: false, op: false },
      saveAccountState: {},
    },
    TEST_ONLY_asyncJobs: {
    },
  },
});

}); // end define