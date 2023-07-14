import telnet_client from 'telnet-client';
import { INPUTS } from './types';
import { Logging, CharacteristicValue } from 'homebridge';

function msleep(n: number) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
  }

const serverControllerPort = 23


export class DenonMarantzController {
    private serverController: telnet_client;
    private readonly log: Logging;
    public readonly ipaddress: string;
    private maxVol: Number;
    private state: { [key: string]: any };
    private COMMANDS: { [key: string]: any } = {
        "PW": ["Power", null],
        "ZM": ["Main Zone", null],
        "Z2": ["Zone 2", this.parseZ2], // will handle Z2MV, Z2SI
        "Z3": ["Zone 3", this.parseZ3], // will handle Z3MV, Z3SI
        "MU": ["Muted", null],
        "Z2MU": ["Z2 Muted", null],
        "Z3MU": ["Z3 Muted", null],
        "MV": ["Volume", this.parseMV],
        "Z2MV": ["Z2 Volume", null],
        "Z3MV": ["Z3 Volume", null],
        "SI": ["Source", null],
        "Z2SI": ["Z2 Source", null],
        "Z3SI": ["Z3 Source", null],
        // "MS": [ "Surround Mode", null],
        // "CV": [ "Channel Bias", null],
        // "PV": [ "Picture Mode", null],
        // "ECO": [ "Eco Mode", null],
        // "SSSOD": [ "Available Source", null],
        // "PSDEL": [ "Sound Delay", null],
        // "PSDRC": [ "Dynamic Range Compression", null],
        // "PSDYNVOL": [ "Dynamic Volume", null],
    }


    constructor(
        log: Logging, ipaddress: string
    ) {
        this.log = log;
        this.ipaddress = ipaddress;
        this.maxVol = 98.0 // good default
        this.serverController = new telnet_client();
        this.log.info("Connecting to Denon/Marantz Controller at ", ipaddress);
        this.serverControllerConnect();
        this.state = {}
        for (const command of Object.keys(this.COMMANDS)) {
            this.state[command] = '-';
        }
    }

    async serverControllerConnect() {
        let params = {
            host: this.ipaddress,
            port: serverControllerPort,
            echoLines: 0,
            irs: '\r',
            negotiationMandatory: false,
            ors: '\r\n',
            separator: false,
            shellPrompt: '',
            timeout: 1500,
        }

        await this.serverController.connect(params);
        this.serverController.on('data', this.serverControllerDataCallback.bind(this));
        this.refresh()
    }

    async refresh() {
        this.log.info("starting refresh")
        Object.keys(this.COMMANDS).forEach((cmd: string) => {
            // for status add question mark
            this.serverControllerSend(`${cmd}?`)
        })

        this.log.info("current state of controller ", this.state)

    }

    private serverControllerDataCallback(data: Buffer) {
        this.parseCommandResult(data.toString())
    }

    async serverControllerSend(data: string) {
        msleep(50);
        this.serverController.send(data);
    }


    private parseMany(cmd: string, data: string) {
        this.log.info(`ParseMany ${cmd} with ${data}`)
        this.state[cmd] = data;
    }

    // only works for main zone, others zones handled differently
    private parseMV(data: string) {
        this.log.info(`ParseMv with ${data}`)

        let isMax = false;
        if (data.startsWith('MAX')) {
            isMax = true;
            data = data.split('MAX')[1]
        }

        let value = Number(data)
        if (data.length > 2) {
            // multipled by 10 to not be float (example: 505 == 50.5)
            value = value / 10
        }

        if (isMax) {
            this.maxVol = value;
        } else {
            this.state['MV'] = value;
        }
    }

    private parseZone(zone: string, data: string) {
        this.log.info(`parseZone ${zone} with ${data}`)
        if (data in ['ON', 'OFF']) {
            this.state[zone] = data;
            return
        }

        if (!isNaN(Number(data))) {
            let value = Number(data)
            if (data.length > 2) {
                // multipled by 10 to not be float (example: 505 == 50.5)
                value = value / 10
            }

            this.state[`${zone}MV`] = value;
            return
        }

        // assume source inputs
        if (data in INPUTS) {
            this.state[`${zone}SI`] = data;
            return
        }

    }

    private parseZ2(data: string) {
        this.parseZone('Z2', data.split('Z2')[1])
    }

    private parseZ3(data: string) {
        this.parseZone('Z3', data.split('Z3')[1])
    }

    private parseCommandResult(data: string) {
        this.log.info(`parsing result ${data}`)
        let results = data.split('\r');
        this.log.info("split results", results)
        results.forEach((result) => {
            Object.keys(this.COMMANDS).forEach((cmd) => {
                if (result.startsWith(cmd)) {
                    if (this.COMMANDS[cmd][1] != null) {
                        this.COMMANDS[cmd][1](result)
                    } else if (result.length !== 0) {
                        this.log.info("split by cmd ", result, cmd, result.split(cmd))
                        this.parseMany(cmd, result.split(cmd)[1].trim())
                    }
                }
            })
        })
    }


    private getPrefixByZone(zone: string): string {
        switch (zone) {
            case 'main':
                return '' //'ZM'
            case 'zone2':
                return 'Z2'
            case 'zone3':
                return 'Z3'
            case 'zone4':
                return 'Z4'
            default:
                // cant happen
                return '??'
        }

    }

    private parseBoolString(b: string): Boolean {
        if (b == 'ON') {
            return true;
        } else {
            return false;
        }
    }

    private boolToString(b: Boolean): string {
        if (b) {
            return 'ON';
        } else {
            return 'OFF';
        }
    }


    GetPowerState(zone: string): Boolean {
        let prefix = this.getPrefixByZone(zone);
        if (zone === 'main') {
            prefix = 'PW'
        }

        return this.parseBoolString(this.state[prefix]);
    }

    async SetPowerState(zone: string, value: boolean) {
        let prefix = this.getPrefixByZone(zone);
        let state = value ? 'ON' : 'OFF'
        if (zone === 'main') {
            prefix = 'PW';
            state = value ? 'ON' : 'STANDBY'
        }
        await this.serverControllerSend(`${prefix}${state}`)
    }

    GetMuteState(zone: string): Boolean {
        let commandPrefix = `${this.getPrefixByZone(zone)}MU`;
        return this.parseBoolString(this.state[commandPrefix])
    }

    async SetMuteSate(zone: string, value: boolean) {
        let commandPrefix = `${this.getPrefixByZone(zone)}MU`
        await this.serverControllerSend(`${commandPrefix}${this.boolToString(value)}`);
    }

    GetVolume(zone: string): Number {
        let commandPrefix = `${this.getPrefixByZone(zone)}MV`;
        return this.state[commandPrefix];
    }

    async SetVolume(zone: string, value: Number) {

        // for some reason this does not work on anything but main zone, 
        // also must give maxVol for it to work
        if (value > this.maxVol) {
            value = this.maxVol;
        }
        if ((Number(value) * 10) % 10) {
            value = 5 * Math.round(Number(value) * 10 / 5)
        }
        let commandPrefix = `${this.getPrefixByZone(zone)}MV${value}\r${this.getPrefixByZone(zone)}MVMAX ${this.maxVol}`;
        await this.serverControllerSend(commandPrefix)
    }

    GetInputSource(zone: string): string {
        let commandPrefix = `${this.getPrefixByZone(zone)}SI`;
        return this.state[commandPrefix];
    }

    async SetInputSource(zone: string, source: string) {
        let command = `${this.getPrefixByZone(zone)}${source}`;
        await this.serverControllerSend(command)
    }
}
