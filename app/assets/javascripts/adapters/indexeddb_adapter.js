//= require lib/uuid

/*global alert uuid*/

var get = Ember.get, set = Ember.set;

// This code initializes the IndexedDB database and defers Ember
// readiness until it gets a reference to an IDBDatabase.
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
    if (!hash || !hash.id) { debugger; }
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

  /**
    Hook used by the store to generate client-side IDs. This simplifies
    the timing of committed related records, so it's preferable.

    For this adapter, we use uuid.js by Rober Kieffer, which generates
    UUIDs using the best-available random number generator.

    @returns {String} a UUID
  */
  generateIdForRecord: function() {
    return uuid();
  },

  /**
    The main entry point called by Ember Data.

    It receives a store to notify when records have
    successfully saved, and a hash of information about
    what to commit.
  */
  save: function(store, commitDetails) {
    var relationships = commitDetails.relationships;

    relationships.forEach(function(relationship) {
      // HACK If a part of the relationship is
      // unmaterialized, also check to see whether
      // it's in any of the commitDetails.
      //
      // The store in Ember Data should really
      // prevent this from happening by correctly
      // hooking up newly materialized records if
      // they are part of a pending relationship.

      var child = relationship.getChild(),
          oldParent = relationship.getOldParent(),
          newParent = relationship.getNewParent();

      if (child === undefined || !this.any(child, commitDetails)) {
        this.updateChildRelationship(store, relationship);
      }

      if (oldParent === undefined || !this.any(oldParent, commitDetails)) {
        this.updateOldParentRelationship(store, relationship);
      }

      if (newParent === undefined || !this.any(newParent, commitDetails)) {
        this.updateNewParentRelationship(store, relationship);
      }
    }, this);

    return this._super.apply(this, arguments);
  },

  /**
    Main hook for saving a newly created record.

    @param {DS.Store} store
    @param {Class} type
    @param {DS.Model} record
  */
  createRecord: function(store, type, record) {
    var hash = this.toJSON(record, { includeId: true });

    this.attemptDbTransaction(store, record, function(dbStore) {
      return dbStore.add(hash);
    });
  },

  /**
    Main hook for updating an existing record.

    @param {DS.Store} store
    @param {Class} type
    @param {DS.Model} record
  */
  updateRecord: function(store, type, record) {
    var hash = this.toJSON(record, { includeId: true });

    this.attemptDbTransaction(store, record, function(dbStore) {
      return dbStore.put(hash);
    });
  },

  /**
    Main hook for deleting an existing record. Note that
    deletions can also trigger changes in relationships with
    other records.

    If those records are unloaded, those changes happen
    through the update*Relationship family of methods.

    @param {DS.Store} store
    @param {Class} type
    @param {DS.Model} record
  */
  deleteRecord: function(store, type, record) {
    this.attemptDbTransaction(store, record, function(dbStore) {
      return dbStore['delete']([ record.constructor.toString(), get(record, 'id') ]);
    });
  },

  /**
    The main hook for finding a single record. The `findMany`
    hook defaults to delegating to this method.

    Since the IndexedDB database is local, we don't need to
    implement a specific `findMany` method.

    @param {DS.Store} store
    @param {Class} type
    @param {String|Number} id
  */
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
  },

  /**
    @private

    Execute some code in the context of an IndexedDB
    transaction. Because operations on an IndexedDB
    database are done on a database's store, this
    method creates a new database transaction, extracts
    its `ember-records` object store and passes it to
    the callback.

    @param {Function} callback a function invoked with
      an IndexedDB object store. Its `this` is set to
      this adapter. This callback is expected to return
      an `IDBRequest` object that is the result of making
      a request on the object store.

    @returns {IDBRequest} An IndexedDB request, such as
      a get, put or delete operation.
  */
  withDbTransaction: function(callback) {
    var db = get(this, 'db');

    var dbTransaction = db.transaction( ['ember-records'], 'readwrite' );
    var dbStore = dbTransaction.objectStore('ember-records');

    return callback.call(this, dbStore);
  },

  /**
    @private

    Attempt to commit a change to a single Ember Data
    record in the context of an IndexedDB transaction.
    This method delegates most of its work to
    `withDbTransaction`.

    It registers a `success` callback on the `IDBRequest`
    returned by `withDbTransaction`, which notifies the
    Ember Data store that the record was successfully
    saved.

    @param {DS.Store} store the store to notify that the
      record was successfully saved to IndexedDB.
    @param {DS.Model} record the record to save. This
      parameter is passed through to the store's
      `didSaveRecord` method if the IndexedDB request
      succeeds.
    @param {Function} callback a function that actually
      makes a request to the IndexedDB database. It is
      invoked with an `IDBObjectStore`, and is expected
      to return an `IDBRequest`.
  */
  attemptDbTransaction: function(store, record, callback) {
    var dbRequest = this.withDbTransaction(callback);

    dbRequest.addEventListener('success', function() {
      store.didSaveRecord(record);
    });
  },

  /**
    @private

    Returns true if the record in question is in any
    of the buckets in `commitDetails`.

    XXX include this on commitDetails? (i.e. `commitDetails.any(record)`)

    @param {DS.Model} record
    @param {Object} commitDetails a commitDetails hash
      passed to this adapter.

    @returns {Boolean}
  */
  any: function(record, commitDetails) {
    // null can never be in commitDetails, and it
    // doesn't require any special commit handling
    if (record === null) { return true; }

    if (commitDetails.created.has(record)) {
      return true;
    }

    if (commitDetails.updated.has(record)) {
      return true;
    }

    if (commitDetails.deleted.has(record)) {
      return true;
    }
  },

  /**
    @private

    Happens if a record's parent is deleted but the children are
    not yet materialized. In server-backed cases, this would normally
    be handled by the server, but as we are maintaining both sides of
    the relationship via the adapter, we have to manage unloaded records
    as well.

    @param {DS.Store} store
    @param {DS.OneToManyChange} relationship
  */
  updateChildRelationship: function(store, relationship) {
    var child = relationship.getChildTypeAndId(),
        parent = relationship.getNewParentTypeAndId(),
        parentId = parent ? parent[1] : null;

    this.updateUnloadedRelationship(child, relationship, function(hash) {
      var key = get(this, 'serializer')._keyForBelongsTo(child[0], relationship.getBelongsToName());
      hash[key] = parentId;
    });
  },

  /**
    @private

    Happens if a record is deleted but its old parent in the
    relationship is unloaded. In relational backends, this would
    take care of itself, because the parent side is just
    computed from an FK that no longer exists. In other
    server-backed cases, an adapter might want to notify the
    server of the change so it can update its parent-side array.

    @param {DS.Store} store
    @param {DS.OneToManyChange} relationship
  */
  updateOldParentRelationship: function(store, relationship) {
    var oldParent = relationship.getOldParentTypeAndId(),
        child = relationship.getChildTypeAndId(),
        childId = child ? child[1] : null;

    this.updateUnloadedRelationship(oldParent, relationship, function(hash) {
      var key = get(this, 'serializer')._keyForHasMany(oldParent[0], relationship.getHasManyName());
      var index = Ember.ArrayPolyfills.indexOf.call(hash[key], childId);
      if (index >= 0) { hash[key].splice(index, 1); }
    });
  },

  /**
    @private

    XXX Is this possible? Should it be possible?

    @param {DS.Store} store
    @param {DS.OneToManyChange} relationship
  */
  updateNewParentRelationship: function(store, relationship) {
    var newParent = relationship.getNewParentTypeAndId(),
        child = relationship.getChildTypeAndId(),
        childId = child ? child[1] : null;

    this.updateUnloadedRelationship(newParent, relationship, function(hash) {
      var key = get(this, 'serializer')._keyForHasMany(newParent[0], relationship.getHasManyName());
      var index = Ember.ArrayPolyfills.indexOf.call(hash[key], childId);
      if (index === -1) { hash[key].push(childId); }
    });
  },

  /**
    @private

    Used by other update*Relationship methods.

    @param {Array(Class, String)} updating a two-element array
      whose first element is the type of the record being
      updated, and whose second element is the id of the record.
    @param {OneToManyChange} relationship the change record that
      contains the information being updated. This method notifies
      the change record that it is doing some persistence work
      for a record not in the `commitDetails`, and lets it know
      when that work is done.
    @param {Function} callback a callback that is called with
      the current version of record in IndexedDB and with its
      `this` set to this adapter. Any mutations to hash
      performed in the callback will be persisted back to the
      IndexedDB database.
  */
  updateUnloadedRelationship: function(updating, relationship, callback) {
    // make sure that we successfully make the change before marking any
    // materialized records that are part of the transaction as clean.
    relationship.wait();

    var updatingDbId = updating.slice(), self = this;
    updatingDbId[0] = updatingDbId[0].toString();

    var lookup = this.withDbTransaction(function(dbStore) {
      return dbStore.get(updatingDbId);
    });

    lookup.addEventListener('error', function() {
      throw new Error("An attempt to update " + updatingDbId[0] + " with id " + updatingDbId[1] + " failed");
    });

    lookup.addEventListener('success', function() {
      var hash = lookup.result;

      if (hash) {
        callback.call(self, hash);

        var put = self.withDbTransaction(function(dbStore) {
          return dbStore.put(hash);
        });

        put.addEventListener('error', function() {
          // fuuuuuu
        });

        put.addEventListener('success', function() {
          relationship.done();
        });
      } else {
        throw new Error("An attempt to update " + updatingDbId[0] + " with id " + updatingDbId[1] + " failed");
      }
    });
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

window.bootstrap = function() {
  Ember.run(function() {
    var person = window.createPerson({ firstName: "Tom", lastName: "Dale" });
    var group = window.createGroup({ name: "Hipsters" });
    group.get('people').addObject(person);
  });
  window.commitStore();
};
