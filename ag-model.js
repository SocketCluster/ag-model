import AGField from './ag-field.js';
const AsyncStreamEmitter = AGField.AsyncStreamEmitter;

// options.socket: The Asyngular client socket to use to sync the model state.
// options.type: The resource type.
// options.id: The resource id.
// options.fields: An array of fields names required by this model.
function AGModel(options) {
  AsyncStreamEmitter.call(this);

  this.socket = options.socket;
  this.type = options.type;
  this.id = options.id;
  this.fields = options.fields;
  this.defaultFieldValues = options.defaultFieldValues;
  this.agFields = {};
  this.value = {
    ...this.defaultFieldValues,
    id: this.id
  };
  this.active = true;
  this.passiveMode = options.passiveMode || false;

  this.fields.forEach((field) => {
    let agField = new AGField({
      socket: this.socket,
      resourceType: this.type,
      resourceId: this.id,
      name: field,
      passiveMode: this.passiveMode
    });
    this.agFields[field] = agField;
    this.value[field] = null;

    (async () => {
      for await (let event of agField.listener('error')) {
        this.emit('error', event);
      }
    })();

    (async () => {
      for await (let event of agField.listener('change')) {
        this.value[event.field] = event.newValue;
        this.emit('change', {
          resourceType: this.type,
          resourceId: this.id,
          resourceField: event.field,
          oldValue: event.oldValue,
          newValue: event.newValue
        });
      }
    })();
  });
}

AGModel.prototype = Object.create(AsyncStreamEmitter.prototype);

AGModel.AsyncStreamEmitter = AsyncStreamEmitter;

AGModel.prototype.save = function () {
  let promises = [];
  Object.values(this.agFields).forEach((agField) => {
    agField.value = this.value[agField.name];
    promises.push(agField.save());
  });
  return Promise.all(promises);
};

AGModel.prototype.update = async function (field, newValue) {
  if (this.agFields[field]) {
    return this.agFields[field].update(newValue);
  }
  let query = {
    type: this.type,
    id: this.id,
    field: field,
    value: newValue
  };
  return this.socket.invoke('update', query);
};

AGModel.prototype.delete = async function (field) {
  let query = {
    type: this.type,
    id: this.id
  };
  if (field != null) {
    if (this.agFields[field]) {
      return this.agFields[field].delete();
    }
    query.field = field;
  }
  return this.socket.invoke('delete', query);
};

AGModel.prototype.destroy = function () {
  this.active = false;
  Object.values(this.agFields).forEach((agField) => {
    agField.killListener('error');
    agField.killListener('change');
    agField.destroy();
  });
};

export default AGModel;
