IndexeddbTest.Person = DS.Model.extend({
  firstName: DS.attr('string'),
  lastName: DS.attr('string'),

  group: DS.belongsTo('IndexeddbTest.Group')
});
