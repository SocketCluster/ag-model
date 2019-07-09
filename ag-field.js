import jsonStableStringify from '../sc-json-stable-stringify/sc-json-stable-stringify.js';
import AsyncStreamEmitter from '../async-stream-emitter/async-stream-emitter.js';

function AGField(options) {
  AsyncStreamEmitter.call(this);

  this.socket = options.socket;
  this.resourceType = options.resourceType;
  this.resourceId = options.resourceId;
  this.name = options.name;
  this.active = true;
  this.passiveMode = options.passiveMode;

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

  this._channelOutputConsumerIds = [];
  this._channelListenerConsumerIds = [];
  this._socketListenerConsumerIds = [];

  (async () => {
    let consumer = this.channel.createConsumer();
    this._channelOutputConsumerIds.push(consumer.id);
    while (true) {
      let packet = await consumer.next();
      if (packet.done) {
        if (!this.active) {
          break;
        }
      } else {
        let payload = packet.value;
        if (payload == null || !this.passiveMode) {
          this.loadData();
        } else {
          let oldValue = this.value;
          if (payload.type === 'delete') {
            this.value = null;
          } else {
            this.value = payload.value;
          }
          this.loadedValue = this.value;
          this._triggerValueChange(oldValue, this.value);
        }
      }
    }
  })();

  (async () => {
    let consumer = this.channel.listener('subscribe').createConsumer();
    this._channelListenerConsumerIds.push(consumer.id);
    while (true) {
      let packet = await consumer.next();
      if (packet.done) {
        if (!this.active) {
          break;
        }
      } else {
        // Fetch data when the subscribe is successful.
        this.loadData();
      }
    }
  })();

  (async () => {
    let consumer = this.channel.listener('subscribeFail').createConsumer();
    this._channelListenerConsumerIds.push(consumer.id);
    while (true) {
      let packet = await consumer.next();
      if (packet.done) {
        if (!this.active) {
          break;
        }
      } else {
        this.emit('error', {error: this._formatError(packet.value.error)});
      }
    }
  })();

  if (this.channel.state === 'subscribed') {
    this.loadData();
  }

  (async () => {
    let consumer = this.socket.listener('authenticate').createConsumer();
    this._socketListenerConsumerIds.push(consumer.id);
    while (true) {
      let packet = await consumer.next();
      if (packet.done) {
        if (!this.active) {
          break;
        }
      } else {
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
  this._channelOutputConsumerIds.forEach((consumerId) => {
    this.channel.killOutputConsumer(consumerId);
  });
  this._channelListenerConsumerIds.forEach((consumerId) => {
    this.channel.killListenerConsumer(consumerId);
  });
  this._socketListenerConsumerIds.forEach((consumerId) => {
    this.socket.killListenerConsumer(consumerId);
  });

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
