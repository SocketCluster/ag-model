import jsonStableStringify from '../sc-json-stable-stringify/sc-json-stable-stringify.js';
import AsyncStreamEmitter from '../async-stream-emitter/index.js';

function AGField(options) {
  AsyncStreamEmitter.call(this);

  this.socket = options.socket;
  this.resourceType = options.resourceType;
  this.resourceId = options.resourceId;
  this.name = options.name;
  this.active = true;

  this.resourceChannelName = `crud>${this.resourceType}/${this.resourceId}/${this.name}`;
  this._symbol = Symbol();

  if (!this.socket.channelWatchers) {
    this.socket.channelWatchers = {};
  }
  if (!this.socket.channelWatchers[this.resourceChannelName]) {
    this.socket.channelWatchers[this.resourceChannelName] = {};
  }
  this.socket.channelWatchers[this.resourceChannelName][this._symbol] = true;

  this.channel = this.socket.subscribe(this.resourceChannelName);

  (async () => {
    while (this.active) {
      for await (let packet of this.channel) {
        if (packet == null) {
          this.loadData();
        } else {
          let oldValue = this.value;
          if (packet.type === 'delete') {
            this.value = null;
          } else {
            this.value = packet.value;
          }
          this.loadedValue = this.value;
          this._triggerValueChange(oldValue, this.value);
        }
      }
    }
  })();

  // TODO 2: Always rebind while instance is active?
  (async () => {
    for await (let event of this.channel.listener('subscribe')) {
      // Fetch data when the subscribe is successful.
      this.loadData();
    }
  })();

  (async () => {
    for await (let {error} of this.channel.listener('subscribeFail')) {
      this.emit('error', {error: this._formatError(error)});
    }
  })();

  if (this.channel.state === 'subscribed') {
    this.loadData();
  }

  (async () => {
    while (this.active) {
      for await (let event of this.socket.listener('authenticate')) {
        this.socket.subscribe(this.resourceChannelName);
      }
    }
  })();
}

AGField.prototype = Object.create(AsyncStreamEmitter.prototype);

AGField.AsyncStreamEmitter = AsyncStreamEmitter;

AGField.prototype._formatError = function (error) {
  if (error) {
    if (error.message) {
      return new Error(error.message);
    }
    return new Error(error);
  }
  return error;
};

AGField.prototype._triggerValueChange = function (oldValue, newValue) {
  this.emit('change', {
    field: this.name,
    oldValue: oldValue,
    newValue: newValue
  });
};

AGField.prototype.loadData = async function () {
  let query = {
    type: this.resourceType,
    id: this.resourceId,
    field: this.name
  };

  let result;
  try {
    result = await this.socket.invoke('read', query);
  } catch (error) {
    this.emit('error', {error: this._formatError(error)});
  }
  let oldValue = this.value;
  this.value = result;
  this.loadedValue = result;
  this._triggerValueChange(oldValue, this.value);
};

AGField.prototype.save = function () {
  if (this.value === this.loadedValue) {
    return Promise.resolve(this.value);
  }
  return this.update(this.value);
};

AGField.prototype.update = async function (newValue) {
  let oldValue = this.value;
  this.value = newValue;
  this._triggerValueChange(oldValue, this.value);
  let query = {
    type: this.resourceType,
    id: this.resourceId,
    field: this.name,
    value: newValue
  };
  return this.socket.invoke('update', query);
};

AGField.prototype.delete = function () {
  let oldValue = this.value;
  this.value = null;
  this._triggerValueChange(oldValue, this.value);
  let query = {
    type: this.resourceType,
    id: this.resourceId,
    field: this.name
  };
  return this.socket.invoke('delete', query);
};

AGField.prototype.destroy = function () {
  if (!this.active) {
    return;
  }
  this.active = false;
  this.socket.killListener('authenticate');
  this.channel.kill();

  let watchers = this.socket.channelWatchers[this.resourceChannelName];
  if (watchers) {
    delete watchers[this._symbol];
  }
  if (!Object.getOwnPropertySymbols(watchers || {}).length) {
    delete this.socket.channelWatchers[this.resourceChannelName];
    this.channel.unsubscribe();
  }
};

export default AGField;
