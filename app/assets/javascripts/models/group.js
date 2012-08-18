IndexeddbTest.Group = DS.Model.extend({
  name: DS.attr('string'),
  people: DS.hasMany('IndexeddbTest.Person')
});
