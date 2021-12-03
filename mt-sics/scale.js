'use strict';
const os = require('os');
const mqtt = require('mqtt');
const sparkplug = require('sparkplug-client');
const repl = require('repl');
const MettlerToledo = require('./mt-sics').MettlerToledo;

const hostname = os.hostname();
//*****************************
// Environment variables
// TTY: '/dev/ttyUSB0'
// BAUDRATE: 38400
// METER_POLL_MS: 250 range 200-5000
// MQTT_EDGE_NODE_ID: hostname
// MQTT_DEVICE_ID: 'WT9999X'
// MQTT_HOST_IP: 'mqtt://127.0.0.1/'
// MQTT_HOST_USERNAME: ''
// MQTT_HOST_PASSWORD: ''
// MQTT_TOPIC_ROOT: 'unassigned'
// SPARKPLUG_GROUP_ID: 'unassigned'

// Set values
let edgeNodeId = process.env.MQTT_EDGE_NODE_ID || hostname;
let deviceId = process.env.MQTT_DEVICE_ID || 'WT9999X';
let mqtt_host_ip = process.env.MQTT_HOST_IP || 'mqtt://127.0.0.1/';
let mqtt_username = process.env.MQTT_HOST_USERNAME || '';
let mqtt_password = process.env.MQTT_HOST_PASSWORD || '';
let mqtt_topic_root = (process.env.MQTT_TOPIC_ROOT || 'unassigned') +'/'+edgeNodeId+'/'+deviceId;
let sparkplug_group_id = process.env.SPARKPLUG_GROUP_ID || 'unassigned';
let spkplgClient = null;


// Set up the Mettler Toledo scale object
const scale = new MettlerToledo({
    tty: (process.env.TTY || '/dev/ttyUSB0'),
    baudrate: constrainInt(process.env.BAUDRATE, 38400, 1200, 115200),
    cmdTimeout: 500,
    measPollMS: constrainInt(process.env.METER_POLL_MS, 250, 200, 5000),
    alivePollMS: 1000,
});

// set up sparkplug values
let spkplg = {
    node: 'Offline',
    device: 'Offline',
    nMetrics: { Make: '', Model: '', Type: '', SerialNumber: '', FirmwareRev: '' },
    dMetrics: { weight: NaN, stable: false, tare: NaN },
};

// Set up MQTT client and connect to serve
let mqttClient = mqtt.connect(mqtt_host_ip, {
    username: mqtt_username,
    password: mqtt_password,
    will: {topic: mqtt_topic_root+'/edgeState', payload: 'Offline', retain: true },
});

mqttClient.on('connect', () => {
    console.error('==== MQTT connected ====');
    mqttClient.publish(mqtt_topic_root+'/edgeState', 'Online', { retain: true });
    mqttSendBuffered(); // send any messages buffered locally while MQTT was not connected
    mqttClient.subscribe(mqtt_topic_root+'/requestSample');
});

mqttClient.on('message', (topic, message) => {
    console.log('Subscribed MQTT Message Received: ', topic, message);
    if (topic === mqtt_topic_root+'/requestSample') {
        scale.getCurrentMeasurement(message.toString());
        console.log('Request Sample received: ', message.toString());
    }
});

mqttClient.on('close', () => {
    console.error('==== MQTT closed ====');
});

mqttClient.on('error', (error) => {
    console.error('==== MQTT error ' + error + ' ====');
});

mqttClient.on('offline', () => {
    console.error('==== MQTT offline ====');
});

mqttClient.on('reconnect', () => {
    mqttClient.publish(mqtt_topic_root+'/edgeState', 'Online', { retain: true });
    console.error('==== MQTT reconnect ====');
});

// Set up MQTT publishing
const mqttConfig = {
    error: { topic: mqtt_topic_root+'/comm/error', retain: false, buffer: [],  limit: 100 },
    state: { topic: mqtt_topic_root+'/comm/state', retain: true, buffer: [],  limit: 1 },
    tx: { topic: mqtt_topic_root+'/comm/tx', retain: false, buffer: [],  limit: 20 },
    rx: { topic: mqtt_topic_root+'/comm/rx', retain: false, buffer: [],  limit: 20 },
    result: { topic: mqtt_topic_root+'/result', retain: true, buffer: [],  limit: 500 },
    requestedSample: { topic: mqtt_topic_root+'/sample', retain: true, buffer: [],  limit: 500 },
    configuration: { topic: mqtt_topic_root+'/configuration', retain: true, buffer: [],  limit: 1 },
};

function mqttSend(type, message) {
    const messageJSON = JSON.stringify(message);
    if (mqttClient.connected) {
        mqttClient.publish(mqttConfig[type].topic, messageJSON, { retain: mqttConfig[type].retain });
    } else {
        mqttConfig[type].buffer.push(messageJSON)
        while (mqttConfig[type].buffer.length > mqttConfig[type].limit) {
            mqttConfig[type].buffer.shift();
        }
    }
}

// Send the first item in each buffer, then call again in 250 ms if any buffer still not empty
function mqttSendBuffered() {
    let bufferDrained = true;
    if (mqttClient.connected) {
        Object.keys(mqttConfig).forEach(key => {
            let msg = mqttConfig[key].buffer.shift();
            if (msg) mqttClient.publish(mqttConfig[key].topic, msg, { retain: mqttConfig[key].retain });
            if (mqttConfig[key].buffer.length > 0) bufferDrained = false;
        });
        if (!bufferDrained) setTimeout(mqttSendBuffered, 250);
    }
}

// Publish to appropriate topic when event received from meter
scale.on('error', (res) => mqttSend('error', res));
scale.on('state', (res) => {
    mqttSend('state', res);
    // sparkplug
    if (scale.state === 'Online' && spkplg.device !== 'Online') { // Publish DBIRTH
        const dbirth = {
            'timestamp' :  Date.now(),
            'metrics' : [
                { 'name' : 'weight', 'value' : scale.lastMeasure.values.weight.value, 'type' : 'Float', 'engUnit' : scale.lastMeasure.values.weight.engUnit },
                { 'name' : 'stable', 'value' : scale.lastMeasure.values.weight.stable, 'type' : 'Boolean' },
                { 'name' : 'tare', 'value' : scale.lastMeasure.values.tare.value, 'type' : 'Float', 'engUnit' : scale.lastMeasure.values.tare.engUnit },
            ]
        };
        spkplgClient.publishDeviceBirth(deviceId, dbirth);
        spkplg.dMetrics = { // save values to compare later
            weight: scale.lastMeasure.values.weight.value,
            stable: scale.lastMeasure.values.weight.stable,
            tare: scale.lastMeasure.values.tare.value,
        };
    } else if (scale.state !== 'Online' && spkplg.device === 'Online') { // Publish DDEATH
        spkplgClient.publishDeviceDeath(deviceId, { 'timestamp' : Date.now() });
    }
    spkplg.device = scale.state;
});
scale.on('tx', (res) => mqttSend('tx', res));
scale.on('rx', (res) => mqttSend('rx', res));
scale.on('result', (res) => {
    mqttSend('result', res);
    try {
        if (res.payload.sampleID !== 'Polled') mqttSend('requestedSample', res);
    } catch (error) {
        console.error(error);
    }
    // sparkplug
    if (scale.state === 'Online') { // Publish DDATA
        let metrics = [];
        if (scale.lastMeasure.values.weight.value !== spkplg.dMetrics.weight) {
            metrics.push({ name: 'weight', type: 'Float', value: scale.lastMeasure.values.weight.value });
        }
        if (scale.lastMeasure.values.weight.stable !== spkplg.dMetrics.stable) {
            metrics.push({ name: 'stable', type: 'Boolean', value: scale.lastMeasure.values.weight.stable });
        }
        if (scale.lastMeasure.values.tare.value !== spkplg.dMetrics.tare) {
            metrics.push({ name: 'tare', type: 'Float', value: scale.lastMeasure.values.tare.value });
        }
        if (metrics.length > 0) {
            spkplgClient.publishDeviceData(deviceId, { timestamp: Date.now(), metrics });
            spkplg.dMetrics = { // save values to compare later
                weight: scale.lastMeasure.values.weight.value,
                stable: scale.lastMeasure.values.weight.stable,
                tare: scale.lastMeasure.values.tare.value,
            };
        }
    }
});
scale.on('configuration', (res) => {
    mqttSend('configuration', res);
    if (spkplg.node === 'Offline') { // Send NBIRTH
        // Setup Sparkplug B client
        const spkplgClientConfig = {
            'username' : mqtt_username,
            'serverUrl' : mqtt_host_ip,
            'password' : mqtt_password,
            'groupId' : sparkplug_group_id,
            'edgeNode' : edgeNodeId,
            'clientId' : 'SparkplugClient_'+edgeNodeId+ '_' + Math.random().toString(16).substr(2, 8),
            'version' : 'spBv1.0'
        };
        spkplgClient = sparkplug.newClient(spkplgClientConfig);
        spkplg.node === 'opening';

        spkplgClient.on('connect', () => {
            //Birth Certificate (NBIRTH)
            const nbirth = {
                'timestamp' : Date.now(),
                'metrics' : [
                    { name: 'Make', type: 'String', value: scale.meterConfig.Make },
                    { name: 'Model', type: 'String', value: scale.meterConfig.Model },
                    { name: 'Type', type: 'String', value: scale.meterConfig.Type },
                    { name: 'SerialNumber', type: 'String', value: scale.meterConfig.SerialNumber },
                    { name: 'FirmwareRev', type: 'String', value: scale.meterConfig.FirmwareRev },
                ]
            };
            spkplgClient.publishNodeBirth(nbirth);
            spkplg.nMetrics = { // save values to compare later
                Make: scale.meterConfig.Make,
                Model: scale.meterConfig.Model,
                Type: scale.meterConfig.Type,
                SerialNumber: scale.meterConfig.SerialNumber,
                FirmwareRev: scale.meterConfig.FirmwareRev,
            };
            spkplg.node = 'Online';
        });

    } else if (spkplg.node === 'Online') { // send NDATA if anythignhas changed
        let metrics = [];
        if (scale.meterConfig.Make !== spkplg.nMetrics.Make) metrics.push({ name: 'Make', type: 'String', value: scale.meterConfig.Make });
        if (scale.meterConfig.Model !== spkplg.nMetrics.Model) metrics.push({ name: 'Model', type: 'String', value: scale.meterConfig.Model });
        if (scale.meterConfig.Model !== spkplg.nMetrics.Type) metrics.push({ name: 'Type', type: 'String', value: scale.meterConfig.Type });
        if (scale.meterConfig.SerialNumber !== spkplg.nMetrics.SerialNumber) metrics.push({ name: 'SerialNumber', type: 'String', value: scale.meterConfig.SerialNumber });
        if (scale.meterConfig.FirmwareRev !== spkplg.nMetrics.FirmwareRev) metrics.push({ name: 'FirmwareRev', type: 'String', value: scale.meterConfig.FirmwareRev });
        if (metrics.length > 0) {
            spkplgClient.publishNodeData({ timestamp: Date.now(), metrics });
            spkplg.nMetrics = { // save values to compare later
                Make: scale.meterConfig.Make,
                Model: scale.meterConfig.Model,
                Type: scale.meterConfig.Type,
                SerialNumber: scale.meterConfig.SerialNumber,
                FirmwareRev: scale.meterConfig.FirmwareRev,
            };
        }
    }
});

// Helper functions
function constrainInt(value, defValue, min, max) {
    value = (value || defValue);
    try {
        value = parseInt(value);
        value = Math.max(Math.min(value, max), min);
    } catch (error) {
        value = defValue;
    }
    return value;
}

// Start instrument communication
scale.open();

const r = repl.start('> ');
Object.assign(r.context, {scale: scale, mqttClient, mqttConfig, spkplg});