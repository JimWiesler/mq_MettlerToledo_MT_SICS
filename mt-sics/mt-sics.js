'use strict';
//*******************************************************
// Opens and polls a Mettler Toledo balance running mt-sics protocol
//*******************************************************
//Load required modules
// const repl = require('repl');
const SerialPort = require('serialport');
const Readline = require('@serialport/parser-readline');
const EventEmitter = require('events');

//*******************************************
// MettlerToledo MT-SICS class
//*******************************************
class MettlerToledo extends EventEmitter {
    constructor(cfg) {
        super();
        this.state = 'Closed'; // See State Machine: Closed, Opening, Offline, Initializing, Online, Closing
        this.cfg = cfg;

        this.port = null;
        this.readParser = null;
        this.meterConfig = {
            'Make': 'Mettler Toledo',
            'Model': 'Uninitiated',
            'Type': 'Uninitiated',
            'SerialNumber': 'Uninitiated',
            'FirmwareRev': 'Uninitiated',
            'Configuration': {
                'WeighMode': 'Uninitiated',
                'EnvironmentalStablility': 'Uninitiated',
                'AutoZeroMode': 'Uninitiated',
                'StandbyTimeout': 'Uninitiated'
            },
        };
        this.lastCommand = { name: 'Pause', cmd: '', timeout: 500, responseRequired: false, pauseAfterResponse: 0 };
        this.initializePending = true;
        this.lastError = {error: '', lastCommand: '', ts: 0};
        this.lastMeasure = {
            status: 'Offline',
            ts: '1900-01-01T12:00:00.000Z',
            sampleID: 'Uninitiated',
            meterTimestamp: 'Uninitiated',
            values: {
                tare: { value: NaN, engUnit: '' },
                weight: { value: NaN, engUnit: '', stable: false },
            }};
        this.sampleRequest = null;
        this.sampleRequestTimeout = null;
        this.cmdTO = cfg.cmdTimeout || 300; // timeout for receiving a new measurement.
        this.commandQueue = [];
        this.commandTimeout = null;
        this.measPollMS = cfg.measPollMS || 100; // how often to grab a measurement
        this.measPollTimeout = null;
        this.alivePollMS = cfg.alivePollMS || 5000; // how often to recheck if link is alive
        this.alivePollInterval = null;
        this.cmds = {
            Poll: { name: 'Poll', cmd: '@\r\n', timeout: this.cmdTO, responseRequired: true, pauseAfterResponse: 0 },
            Pause: { name: 'Pause', cmd: '', timeout: 50, responseRequired: false, pauseAfterResponse: 0 },
            getWeightImmediate: { name: 'getWeightImmediate', cmd: 'SI\r\n', timeout: this.cmdTO, responseRequired: true, pauseAfterResponse: 0 },
            getSetTare: { name: 'getSetTare', cmd: 'TA\r\n', timeout: this.cmdTO, responseRequired: true, pauseAfterResponse: 0 },
            getModel: { name: 'getModel', cmd: 'I11\r\n', timeout: this.cmdTO, responseRequired: true, pauseAfterResponse: 0 },
            getScaleType: { name: 'getScaleType', cmd: 'I2\r\n', timeout: this.cmdTO, responseRequired: true, pauseAfterResponse: 0 },
            getSerialNumber: { name: 'getSerialNumber', cmd: 'I4\r\n', timeout: this.cmdTO, responseRequired: true, pauseAfterResponse: 0 },
            getFirmware: { name: 'getFirmware', cmd: 'I3\r\n', timeout: this.cmdTO, responseRequired: true, pauseAfterResponse: 0 },
            getSetWeighMode: { name: 'getSetWeighMode', cmd: 'M01\r\n', timeout: this.cmdTO, responseRequired: true, pauseAfterResponse: 0 },
            getSetEnvStability: { name: 'getSetEnvStability', cmd: 'M02\r\n', timeout: this.cmdTO, responseRequired: true, pauseAfterResponse: 0 },
            getSetAutoZero: { name: 'getSetAutoZero', cmd: 'M03\r\n', timeout: this.cmdTO, responseRequired: true, pauseAfterResponse: 0 },
            getSetStandbyTimeout: { name: 'getSetStandbyTimeout', cmd: 'M16\r\n', timeout: this.cmdTO, responseRequired: true, pauseAfterResponse: 0 },
            getSetTime: { name: 'getSetTime', cmd: 'TIM REPLACE1\r\n', timeout: this.cmdTO, responseRequired: true, pauseAfterResponse: 0 },
            getSetDate: { name: 'getSetDate', cmd: 'DAT REPLACE1\r\n', timeout: this.cmdTO, responseRequired: true, pauseAfterResponse: 0 },
            getSetDeviceID: { name: 'getSetDeviceID', cmd: 'I10 "REPLACE1"\r\n', timeout: this.cmdTO, responseRequired: true, pauseAfterResponse: 0 },
            displayText: { name: 'displayText', cmd: 'D "REPLACE1"\r\n', timeout: this.cmdTO, responseRequired: true, pauseAfterResponse: 0 },
            displayWeight: { name: 'displayWeight', cmd: 'DW\r\n', timeout: this.cmdTO, responseRequired: true, pauseAfterResponse: 0 },
            beep: { name: 'beep', cmd: 'M12 3\r\n', timeout: this.cmdTO, responseRequired: true, pauseAfterResponse: 0 },
        };
        // Start Polling - this.state has to be correct for port to be accessed
        this.measurePoll();
        this.alivePoll();
        this.cmdLoop("Timeout");
    }

    // Measure Request Poll Cycle
    measurePoll() {
        let me = this;
        if (this.state.includes('Online')) {
            this.write(this.cmds.getSetTare); // Always get Tare weight
            this.write(this.cmds.getWeightImmediate); // Get weight immediate - some readings will be unstable
        }
        this.measPollTimeout = setTimeout(me.measurePoll.bind(me), this.measPollMS); // run this again in the future
    }

    // Alive Poll Cycle
    alivePoll() {
        let me = this;
        if (this.state === 'Offline') {
            this.write(this.cmds.Poll);
        }
        this.alivePollInterval = setTimeout(me.alivePoll.bind(me), this.alivePollMS);
    }

    // Open port
    open() {
        const me = this;
        try {
            this.port = new SerialPort(this.cfg.tty, {
                baudRate: this.cfg.baudrate,
                dataBits: 8,
                stopBits: 1,
                parity: 'none',
              });
            this.readParser = this.port.pipe(new Readline({ delimiter: '\r\n' }));
            this.readParser.on('data', function (data) {
                me.read(data);
            });
            this.port.on('error', function(error) {
                me.emit('error', { utc: utc(), payload: 'Port Error: '+ error });
                me.close();
            });
            this.port.on('close', function(res) {
                me.setState('Closed');
            });
            this.setState('Offline');
        } catch (error) {
            this.emit('error', { utc: utc(), payload: 'Port Failed to open: ', error });
            this.setState('Closed');
        }
    }

    // Close port
    close() {
        this.setState('Closing');
        if (this.port.isOpen) {
            this.port.close(); // Note - Close event handler will manage the state change to Closed
        } else {
            this.setState('Closed');
        }
    }

    // Write Commands to command queue
    write(c, r1, r2) {
        let command = {...c} // get shallow copy
        r1 = r1 || '';
        r2 = r2 || '';
        command.cmd = command.cmd.replace('REPLACE1', r1).replace('REPLACE2', r2); // Replace placeholders in command
        this.commandQueue.push(command);
    }

    // State management
    setState(newState) {
        console.log('setState ==> Old State: '+this.state+' New State: '+newState);
        this.commandQueue = [];
        this.state = newState;
        this.lastCommand = {...this.cmds.Pause};
        this.emit("state", { utc: utc(), payload: this.state} );
    }

    // Main Poll loop - this loop (and the commandTimeout) should never stop
    cmdLoop(caller) {
        let me = this;
        // console.log('cmdLoop ==> State: '+this.state+' Caller: '+caller+' Last Command: '+JSON.stringify(this.lastCommand));

        // Check if state should change
        if (this.lastCommand.responseRequired) {
            if (this.state === 'Offline' && caller === 'ResponseReceived' && this.lastCommand.name === 'Poll') {
                this.setState("Initializing"); // Always go back through Initializing to grab S/N etc. that might have changed.
                this.configMeter();
            } else if (this.state === 'Initializing' && caller === 'ResponseReceived' && this.lastCommand.name === 'getWeightImmediate') {
                this.setState("Online"); // All is good - start collecting data
            } else if (this.state === 'Initializing' && caller === 'Timeout' && this.lastCommand.name === 'getWeightImmediate') {
                this.setState("Offline"); // Go back to Polling
            } else if (this.state === 'Online' && caller === 'Timeout') {
                this.setState("Offline"); // Go back to polling
            }
        }

        // Determine next command (or 'pause' command)
        let cmd = {...this.cmds.Pause};
        if (this.lastCommand.responseRequired && this.lastCommand.pauseAfterResponse > 0) { // Send last command's pause
            cmd.timeout = this.lastCommand.pauseAfterResponse;
        } else if (this.commandQueue.length > 0) { // get new command from queue
            let c = this.commandQueue.shift();
            cmd = {...c};
        }

        // Send command
        this.lastCommand = cmd;
        if (cmd.cmd && cmd.cmd.length > 0){
            this.port.write(cmd.cmd);
            this.emit('tx', { utc: utc(), payload: cmd.cmd.replace('\n','').replace('\r','') });
        }

        // Set timeout so this polling function is always active in the event loop
        // console.log('     Huh???',JSON.stringify(cmd))
        this.commandTimeout = killTimeout(this.commandTimeout); // Cancel previous timeout if not fired
        this.commandTimeout = setTimeout(()=>{
            // console.log('**********************Timeout*********************')
            me.cmdLoop('Timeout');
        }, cmd.timeout);
    }

    // All read handling
    read(inp) {
        // If prompt string is in result, this is an Echo and should be discarded
        let responseToCommand = false;
        // console.log('Input: "'+inp+'" Cmd: "'+this.lastCommand.cmd.replace('\r\n', '')+'"')

        // Clean up the input by trimming and deleting any CR LF or ESC characters
        inp = inp.replace('\n','').replace('\r','').replace('\x1B', '').trim(); // LF, CR, ESC, white space
        if (inp.length === 0) return; // Ignore blank lines

        // Send event that new input received
        this.emit('rx', { utc: utc(), payload: inp });

        // Determine what type of input it is and handle it
        let rxID = '';
        let cmdID = '';
        try {
            rxID = inp.match(/^(\w+)/)[1]; // The first word of reply usually matches command
            cmdID = this.lastCommand.cmd.replace('SI', 'S').replace('@', 'I4'); // The first word of command (@ produces same response as I4)
            let cmdMatch = cmdID.match(/^(\w+)/);
            if (cmdMatch) {
                cmdID = cmdID.match(/^(\w+)/)[1];
                responseToCommand = (cmdID === rxID);
            }
        } catch (error) {
            console.log ('Input: "'+inp+'" Cmd: "'+this.lastCommand.cmd.replace('\r\n', '')+'"', error);
            return;
        }

        if (inp.match( /^E/ )) { // Error Message always start with E
            this.lastError = {error: inp, lastCommand: this.lastCommand.name, ts: Date.now()};
        } else if (rxID === 'S') { // Scale value - weight
            this.updateWeight(inp);
        } else if (rxID === 'TA') { // Tare weight
            this.updateTare(inp);
        } else if (rxID === 'I11') { // Model
            this.updateModel(inp);
        } else if (rxID === 'I2') { // Scale Type
            this.updateType(inp);
        } else if (rxID === 'I4') { // Serial Number
            this.updateSN(inp);
        } else if (rxID === 'I3') { // Firmware
            this.updateFW(inp);
        } else if (rxID === 'M01') { // Weigh Mode
            this.updateWeighMode(inp);
        } else if (rxID === 'M02') { // Stability
            this.updateStability(inp);
        } else if (rxID === 'M03') { // Auto Zero mode
            this.updateAutoZero(inp);
        } else if (rxID === 'M16') { // Standby Timeout
            this.updateStandbyTimeout(inp);
        } else if (!responseToCommand) {
            console.log(inp, " TODO, unexpected response");
        }

        // If this read line is in response to a request, continue the poll
        if (responseToCommand) {
            this.cmdLoop('ResponseReceived');
        }
    }

    // ****************************************************************************
    // Command sending routines
    // ****************************************************************************
    // Generic Send command in case you want to try other commands ad hoc
    send(cmd) {
        if (Object.keys(this.cmds).includes(cmd)) {
            this.write(this.cmds[cmd]);
        } else{
            let c = { name: 'Custom', cmd: cmd, timeout: 1000, responseRequired: false, pauseAfterResponse: 0 };
            this.write(c);
        }
    }

    // Configure critical parts of meter and read config
    configMeter() {
        this.initializePending = false;
        const now = new Date();
        let timestring = now.getHours().toString().padStart(2, '0') + ' ' +
                         now.getMinutes().toString().padStart(2, '0') + ' ' +
                         now.getSeconds().toString().padStart(2, '0');
        let datestring = now.getDate().toString().padStart(2, '0') + ' ' +
                         (now.getMonth()+1).toString().padStart(2, '0') + ' ' +
                         now.getFullYear().toString();
        // Send commands
        this.write(this.cmds.getModel);
        this.write(this.cmds.getScaleType);
        this.write(this.cmds.getSerialNumber);
        this.write(this.cmds.getFirmware);
        this.write(this.cmds.getSetWeighMode);
        this.write(this.cmds.getSetEnvStability);
        this.write(this.cmds.getSetAutoZero);
        this.write(this.cmds.getSetStandbyTimeout);
        this.write(this.cmds.getSetTime, timestring);
        this.write(this.cmds.getSetDate, datestring);
        this.write(this.cmds.getSetDeviceID, this.cfg.deviceID || 'Tagname');
        this.write(this.cmds.beep);
        this.write(this.cmds.getSetTare); // Always get Tare weight
        this.write(this.cmds.getWeightImmediate); // Get weight immediate - some readings will be unstable
    }

    // Request current measurement, optionally with a sampleID
    // This is for a non-polled sample request, usually from outside the class
    getCurrentMeasurement(sampleRequest) {
        const me = this;
        me.sampleRequestTimeout = killTimeout(me.sampleRequestTimeout);
        if (sampleRequest) {
            this.sampleRequest = sampleRequest; // attach a sample ID to result if requested
            this.sampleRequestTimeout = setTimeout(() => {
                me.emit('error', { utc: utc(), payload: 'Sample Request Timeout: ' + me.sampleRequest });
                me.sampleRequest = null;
                me.sampleRequestTimeout = killTimeout(me.sampleRequestTimeout);
            }, this.measPollMS+3000);
        }
        // No need to run this as it is Online and Polling for data - this.write(this.cmds.GetData);
    }

    //*********************************************************
    // All the response handlers
    //*********************************************************

    // Update the last measurement - always fire event
    updateWeight(inp) {
        let match = inp.match(/^S (\w) +(\S+) (\S+)/);
        if (!match) return console.log(inp, ' Incorrect weight format');
        let stable = (match[1] === 'S');
        let value = parseFloat(match[2]);
        let engUnit = match[3];

        // respond based on whether this is a polled response or intitiated remotely
        let sampleID = 'Polled';
        if (this.sampleRequest) {
            this.sampleRequestTimeout = killTimeout(this.sampleRequestTimeout);
            sampleID = this.sampleRequest;
            this.sampleRequest = null;
        } else if (this.lastCommand.name !== 'getWeightImmediate') {
            sampleID = 'Manual';
        }
        if (sampleID !== 'Polled'){
            this.write(this.cmds.beep);
            this.write(this.cmds.beep);
            this.write(this.cmds.beep);
        }

        this.lastMeasure.ts = (new Date()).toISOString();
        this.lastMeasure.status = 'Good';
        this.lastMeasure.sampleID = sampleID;
        // only emit if value changes
        let last = JSON.stringify(this.lastMeasure.values.weight);
        this.lastMeasure.values.weight = { value, engUnit, stable };
        if (sampleID !== 'Polled' || last !== JSON.stringify(this.lastMeasure.values.weight)) {
            this.emit('result', { utc: utc(), payload: this.lastMeasure });
        }
    }

    // Update the last Tare weight
    updateTare(inp) {
        let match = inp.match(/^TA (\w) +(\S+) (\S+)/);
        if (!match) return console.log(inp, ' Incorrect Tare format');
        let last = JSON.stringify(this.lastMeasure.values.tare);
        this.lastMeasure.values.tare = { value: parseFloat(match[2]), engUnit: match[3] };
        if (last !== JSON.stringify(this.lastMeasure.values.tare)) {
            this.emit('result', { utc: utc(), payload: this.lastMeasure });
        }
    }

    // Update the model field
    updateModel(inp) {
        let match = inp.match(/^I11 A "(.+)"/);
        if (!match) return console.log(inp, ' Incorrect Model format');
        let last = JSON.stringify(this.meterConfig);
        this.meterConfig.Model = match[1];
        if (last !== JSON.stringify(this.meterConfig)) {
            this.emit('configuration', { utc: utc(), payload: this.meterConfig });
        }
    }

    // Update the Type field
    updateType(inp) {
        let match = inp.match(/^I2 A "(.+)"/);
        if (!match) return console.log(inp, ' Incorrect Type format');
        let last = JSON.stringify(this.meterConfig);
        this.meterConfig.Type = match[1];
        if (last !== JSON.stringify(this.meterConfig)) {
            this.emit('configuration', { utc: utc(), payload: this.meterConfig });
        }
    }

    // Update the Serial Number field
    updateSN(inp) {
        let match = inp.match(/^I4 A "(.+)"/);
        if (!match) return console.log(inp, ' Incorrect S/N format');
        let last = JSON.stringify(this.meterConfig);
        this.meterConfig.SerialNumber = match[1];
        if (last !== JSON.stringify(this.meterConfig)) {
            this.emit('configuration', { utc: utc(), payload: this.meterConfig });
        }
    }

    // Update the Firmware field
    updateFW(inp) {
        let match = inp.match(/^I3 A "(.+)"/);
        if (!match) return console.log(inp, ' Incorrect F/W format');
        let last = JSON.stringify(this.meterConfig);
        this.meterConfig.FirmwareRev = match[1];
        if (last !== JSON.stringify(this.meterConfig)) {
            this.emit('configuration', { utc: utc(), payload: this.meterConfig });
        }
    }

    // Update the Weigh Mode field
    updateWeighMode(inp) {
        let match = inp.match(/^M01 A (\d)/);
        try {
            let val = ["Normal", "Dosing"][parseInt(match[1])];
            let last = JSON.stringify(this.meterConfig);
            this.meterConfig.Configuration.WeighMode = val;
            if (last !== JSON.stringify(this.meterConfig)) {
                this.emit('configuration', { utc: utc(), payload: this.meterConfig });
            }
        } catch (error) {
            console.log(inp, ' Incorrect Weigh mode format');
        }
    }

    // Update the Stability Mode field
    updateStability(inp) {
        let match = inp.match(/^M02 A (\d)/);
        try {
            let val = ["Very Stable", "Stable", "Standard", "Unstable", "Very Unstable", "Automatic"][parseInt(match[1])];
            let last = JSON.stringify(this.meterConfig);
            this.meterConfig.Configuration.EnvironmentalStablility = val;
            if (last !== JSON.stringify(this.meterConfig)) {
                this.emit('configuration', { utc: utc(), payload: this.meterConfig });
            }
        } catch (error) {
            console.log(inp, ' Incorrect Stabiity format');
        }
    }

    // Update the Auto Zero Mode field
    updateAutoZero(inp) {
        let match = inp.match(/^M03 A (\d)/);
        try {
            let val = ["Off", "On"][parseInt(match[1])];
            let last = JSON.stringify(this.meterConfig);
            this.meterConfig.Configuration.AutoZeroMode = val;
            if (last !== JSON.stringify(this.meterConfig)) {
                this.emit('configuration', { utc: utc(), payload: this.meterConfig });
            }
        } catch (error) {
            console.log(inp, ' Incorrect Auto Zero format');
        }
    }

    // Update the standby timeout field
    updateStandbyTimeout(inp) {
        let match = inp.match(/^M16 (\d)/);
        try {
            let val = ["Off", "5 min", "10 min", "30 min", "60 min", "120 min", "240 min"][parseInt(match[1])];
            let last = JSON.stringify(this.meterConfig);
            this.meterConfig.Configuration.StandbyTimeout = val;
            if (last !== JSON.stringify(this.meterConfig)) {
                this.emit('configuration', { utc: utc(), payload: this.meterConfig });
            }
        } catch (error) {
            console.log(inp, ' Incorrect Standby timeout format');
        }
    }

}

// Utility functions
function utc() { // Generate ISO string of current date/time in UTC
    return (new Date().toISOString());
}

function killTimeout(to) {
    if (to) {
        clearTimeout(to);
    }
    return null;
}

module.exports.MettlerToledo = MettlerToledo;

// Leaving this in as comments
// const r = new MettlerToledo({ tty: '/dev/ttyUSB0', baudrate: 38400 });
// r.on('error', (res) => console.log('Event->error:', res));
// r.on('state', (res) => console.log('Event->state:', res));
// r.on('tx', (res) => console.log('Event->tx:', res));
// r.on('rx', (res) => console.log('Event->rx:', res));
// r.on('result', (res) => console.log('Event->result:', res.sampleID, res.values.pH.value));
// r.on('configuration', (res) => console.log('Event->configuration:', JSON.stringify(res)));
// r.on('calibration', (res) => console.log('Event->calibration for '+res+':'));
// repl.start('> ').context.r = r;
