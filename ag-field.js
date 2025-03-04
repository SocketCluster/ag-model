import jsonStableStringify from '../sc-json-stable-stringify/sc-json-stable-stringify.js';
import AsyncStreamEmitter from '../async-stream-emitter/async-stream-emitter.min.js';

function AGField(options) {
  AsyncStreamEmitter.call(this);

  this.socket = options.socket;
  this.resourceType = options.resourceType;
  this.resourceId = options.resourceId;
  this.name = options.name;
  this.transformations = options.transformations || {};
  this.isActive = true;
  this.isLoaded = false;
  this.isUpdating = false;
  this.isDeleting = false;
  this.passiveMode = options.passiveMode;
  this.publisherId = AGField.getFieldPublisherId(options.publisherId, this.name);

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
        if (!this.isActive) {
          break;
        }
      } else {
        let payload = packet.value;
        if (this.publisherId && payload && payload.publisherId === this.publisherId) continue;
        if (
          payload == null ||
          (!this.passiveMode && payload.type !== 'delete')
        ) {
          this.loadData();
        } else {
          let oldValue = this.value;
          if (payload.type === 'delete') {
            this.value = null;
          } else {
            this.value = payload.value;
          }
          this.loadedValue = this.value;
          this._triggerValueChange(oldValue, this.value, true);
        }
      }
    }
  })();

  // The purpose of useFastInitLoad is to reduce latency of the initial load
  // when the field is first created.
  let useFastInitLoad;

  if (this.socket.state == 'open') {
    this.loadData();
    useFastInitLoad = true;
  } else {
    useFastInitLoad = false;
  }

  (async () => {
    let consumer = this.channel.listener('subscribe').createConsumer();
    this._channelListenerConsumerIds.push(consumer.id);
    while (true) {
      let packet = await consumer.next();
      if (packet.done) {
        if (!this.isActive) {
          break;
        }
      } else {
        // Fetch data when subscribe is successful.
        // If useFastInitLoad was used, then do not load again the first time.
        if (useFastInitLoad) {
          useFastInitLoad = false;
        } else {
          this.loadData();
        }
      }
    }
  })();

  (async () => {
    let consumer = this.channel.listener('subscribeFail').createConsumer();
    this._channelListenerConsumerIds.push(consumer.id);
    while (true) {
      let packet = await consumer.next();
      if (packet.done) {
        if (!this.isActive) {
          break;
        }
      } else {
        useFastInitLoad = false;
        this.emit('error', {error: this._formatError(packet.value.error)});
      }
    }
  })();

  (async () => {
    let consumer = this.socket.listener('close').createConsumer();
    this._socketListenerConsumerIds.push(consumer.id);
    while (true) {
      let packet = await consumer.next();
      if (packet.done) {
        if (!this.isActive) {
          break;
        }
      } else {
        useFastInitLoad = false;
      }
    }
  })();

  (async () => {
    let consumer = this.socket.listener('authenticate').createConsumer();
    this._socketListenerConsumerIds.push(consumer.id);
    while (true) {
      let packet = await consumer.next();
      if (packet.done) {
        if (!this.isActive) {
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

AGField.getFieldPublisherId = function (publisherId, fieldName) {
  if (!publisherId) return null;
  return `${publisherId}/${fieldName}`;
};

AGField.prototype._formatError = function (error) {
  if (error) {
    if (error.message) {
      let formattedError = new Error(error.message);
      if (error.name) {
        formattedError.name = error.name;
      }
      return formattedError;
    }
    return new Error(error);
  }
  return error;
};

AGField.prototype._triggerValueChange = function (oldValue, newValue, isRemote) {
  if (oldValue === newValue) return;
  this.emit('change', {
    field: this.name,
    oldValue: oldValue,
    newValue: newValue,
    isRemote
  });
};

AGField.prototype.loadData = async function () {
  let query = {
    action: 'read',
    type: this.resourceType,
    id: this.resourceId,
    field: this.name
  };
  if (this.transformations.sliceTo != null) {
    query.sliceTo = this.transformations.sliceTo;
  }

  let result;
  try {
    result = await this.socket.invoke('crud', query);
  } catch (error) {
    this.emit('error', {error: this._formatError(error)});
    return;
  }

  if (this.isUpdating || this.isDeleting) {
    if (!this.isLoaded) {
      this.isLoaded = true;
      this.emit('load', {});
    }
    return;
  }

  let oldValue = this.value;
  this.value = result;
  this.loadedValue = result;

  if (!this.isLoaded) {
    this.isLoaded = true;
    this.emit('load', {});
  }

  this._triggerValueChange(oldValue, this.value, true);
};

AGField.prototype.save = async function () {
  if (this.value === this.loadedValue) {
    return Promise.resolve(this.value);
  }
  return this.update(this.value);
};

AGField.prototype.update = async function (newValue) {
  let oldValue = this.value;
  this.value = newValue;
  this.isUpdating = true;
  this._triggerValueChange(oldValue, this.value, false);
  let query = {
    action: 'update',
    type: this.resourceType,
    id: this.resourceId,
    field: this.name,
    value: newValue
  };
  if (this.publisherId) {
    query.publisherId = this.publisherId;
  }
  try {
    await this.socket.invoke('crud', query);
  } catch (error) {
    this.isUpdating = false;
    throw error;
  }
  this.isUpdating = false;
};

AGField.prototype.delete = async function () {
  let oldValue = this.value;
  this.value = null;
  this.isDeleting = true;
  this._triggerValueChange(oldValue, this.value, false);
  let query = {
    action: 'delete',
    type: this.resourceType,
    id: this.resourceId,
    field: this.name
  };
  if (this.publisherId) {
    query.publisherId = this.publisherId;
  }
  try {
    await this.socket.invoke('crud', query);
  } catch (error) {
    this.isDeleting = false;
    throw error;
  }
  this.isDeleting = false;
};

AGField.prototype.destroy = function () {
  this.killAllListeners();
  if (!this.isActive) {
    return;
  }
  this.isActive = false;
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
