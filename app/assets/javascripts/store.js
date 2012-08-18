//= require adapters/indexeddb_adapter

IndexeddbTest.Store = DS.Store.extend({
  revision: 5,
  adapter: IndexeddbTest.IndexedDBAdapter.create()
});

