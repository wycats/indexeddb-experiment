//= require lib/uuid

/*global alert uuid*/

var get = Ember.get, set = Ember.set;

Ember.onLoad('application', function(app) {
  app.deferReadiness();

  var indexedDB = window.indexedDB || window.webkitIndexedDB || window.mozIndexedDB || window.msIndexedDB;

  window.nukeDB = function() {
    indexedDB.deleteDatabase('ember-records');
  };

  var createSchema = function(db) {
    db.createObjectStore('ember-records', { keyPath: 'id' });
  };

  var oldUpgradeNeededCheck = function(db, callback) {
    if (db.version !== '1') {
      var setVersion = db.setVersion('1');
      setVersion.addEventListener('success', function() {
        createSchema(db);

        // Don't indicate readiness if still inside of the
        // "setVersion transaction". This craziness is
        // removed from the upgradeneeded version of the API.
        //
        // This returns the thread of execution to the
        // browser, thus ending the transaction.
        setTimeout(function() {
          callback(null, db);
        }, 1);
      });
    } else {
      callback(null, db);
    }
  };

  var openDB = function(name, callback) {
    var request = indexedDB.open(name, 1);

    // In the newer version of the API, if the version of the
    // schema passed to `open()` is newer than the current
    // version of the schema, this event is triggered before
    // the browser triggers the `success` event..
    request.addEventListener('upgradeneeded', function(event) {
      createSchema(request.result);
    });

    request.addEventListener('error', function(event) {
      // Node-style "error-first" callbacks.
      callback(event);
    });

    request.addEventListener('success', function(event) {
      var db = request.result;

      // Chrome (hopefully "Old Chrome" soon)
      if ('setVersion' in db) {
        oldUpgradeNeededCheck(db, callback);
      } else {
        // In the sane version of the spec, the success event
        // is only triggered once the schema is up-to-date
        // for the current version.
        callback(null, db);
      }
    });
  };

  openDB('ember-records', function(error, db) {
    if (error) {
      // TODO: There is some kind of API that seems to require conversion from
      // a numeric error code to a human code.
      throw new Error("The ember-records database could not be opened for some reason.");
    }

    set(app, 'router.store.adapter.db', db);
    app.advanceReadiness();
  });
});

var serializer = DS.Serializer.extend({
  addId: function(hash, type, id) {
    hash.id = [type.toString(), id];
  },

  extractId: function(type, hash) {
    // TODO: This is fucked
    //
    // newly created records should not try to materialize
    if (hash && hash.id) { return hash.id[1]; }
  },

  addBelongsTo: function(hash, record, key, relationship) {
    hash[relationship.key] = get(get(record, key), 'id');
  },

  addHasMany: function(hash, record, key, relationship) {
    var ids = get(record, key).map(function(child) {
      return get(child, 'id');
    });

    hash[relationship.key] = ids;
  }
}).create();

IndexeddbTest.IndexedDBAdapter = DS.Adapter.extend({
  serializer: serializer,

  generateIdForRecord: function() {
    return uuid();
  },

  withDbTransaction: function(callback) {
    var db = get(this, 'db');

    var dbTransaction = db.transaction( ['ember-records'], 'readwrite' );
    var dbStore = dbTransaction.objectStore('ember-records');

    return callback.call(this, dbStore);
  },

  attemptDbTransaction: function(store, record, callback) {
    var dbRequest = this.withDbTransaction(callback);

    dbRequest.addEventListener('success', function() {
      store.didSaveRecord(record);
    });
  },

  createRecord: function(store, type, record) {
    var hash = this.toJSON(record, { includeId: true });

    this.attemptDbTransaction(store, record, function(dbStore) {
      return dbStore.add(hash);
    });
  },

  updateRecord: function(store, type, record) {
    var hash = this.toJSON(record, { includeId: true });

    this.attemptDbTransaction(store, record, function(dbStore) {
      console.log(hash);
      debugger;
      return dbStore.put(hash);
    });
  },

  deleteRecord: function(store, type, record) {
    this.attemptDbTransaction(store, record, function(dbStore) {
      return dbStore['delete']([ record.constructor.toString(), get(record, 'id') ]);
    });
  },

  find: function(store, type, id) {
    var db = get(this, 'db'),
        dbId = [type.toString(), id];

    var dbTransaction = db.transaction( ['ember-records'] );
    var dbStore = dbTransaction.objectStore('ember-records');

    var request = dbStore.get(dbId);

    request.onerror = function(event) {
      throw new Error("An attempt to retrieve " + type + " with id " + id + " failed");
    };

    request.onsuccess = function(event) {
      var hash = request.result;

      if (hash) {
        store.load(type, request.result);
      } else {
        // there was nothing in the store. use ember-data's amazing error
        // handling support to deal with this issue
      }
    };
  }
});

window.findGroup = function(id) {
  return IndexeddbTest.Group.find(id);
};

window.findPerson = function(id) {
  return IndexeddbTest.Person.find(id);
};

window.createPerson = function(hash) {
  return IndexeddbTest.Person.createRecord(hash);
};

window.createGroup = function(hash) {
  return IndexeddbTest.Group.createRecord(hash);
};

window.commitStore = function() {
  IndexeddbTest.router.store.commit();
};
