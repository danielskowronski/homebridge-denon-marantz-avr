import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { DenonMarantzAVRPlatform } from './platform';
import { DenonMarantzController } from './controller';
import {
    INPUTS,
    Input,
    Zone,
} from './types.js';

interface CachedServiceData {
    Identifier: number;
    CurrentVisibilityState: number;
    ConfiguredName: string;
}

export class DenonMarantzAVRAccessory {
    private service: Service;
    private inputServices: Service[] = [];
    private readonly zone: Zone;

    private state: {
        isPlaying: boolean; // TODO: Investigaste a better way of tracking "playing" state
        inputs: Input[];
        connectionError: boolean;
    } = {
            isPlaying: true,
            inputs: [],
            connectionError: false,
        };

    constructor(
        private readonly platform: DenonMarantzAVRPlatform,
        private readonly accessory: PlatformAccessory,
        zone: Zone,
        private controller: DenonMarantzController,
    ) {

        // set the AVR accessory information
        this.accessory
            .getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Denon/Marantz')

        this.service = this.accessory.addService(this.platform.Service.Television);
        this.zone = zone;
        this.init();

        // regularly ping the AVR to keep power/input state syncronised
        setInterval(this.updateAVRState.bind(this), 300000);
    }

    async init() {
        try {
            await this.updateInputSources();
            await this.createTVService();
            await this.createTVSpeakerService();
            await this.createInputSourceServices();
        } catch (err) {
            this.platform.log.error(err as string);
        }
    }

    async createTVService() {
        // Set Television Service Name & Discovery Mode
        this.service
            .setCharacteristic(this.platform.Characteristic.ConfiguredName, this.accessory.context.device.displayName)
            .setCharacteristic(
                this.platform.Characteristic.SleepDiscoveryMode,
                this.platform.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE,
            );

        // Power State Get/Set
        this.service
            .getCharacteristic(this.platform.Characteristic.Active)
            .onSet(this.setPowerState.bind(this))
            .onGet(this.getPowerState.bind(this));

        // Input Source Get/Set
        this.service
            .getCharacteristic(this.platform.Characteristic.ActiveIdentifier)
            .onSet(this.setInputState.bind(this))
            .onGet(this.getInputState.bind(this));

        // Remote Key Set
        // this.service.getCharacteristic(this.platform.Characteristic.RemoteKey).onSet(this.setRemoteKey.bind(this));

        return;
    }

    async createTVSpeakerService() {
        const speakerService = this.accessory.addService(this.platform.Service.TelevisionSpeaker);

        speakerService
            .setCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.ACTIVE)
            .setCharacteristic(
                this.platform.Characteristic.VolumeControlType,
                this.platform.Characteristic.VolumeControlType.ABSOLUTE,
            );
        speakerService.getCharacteristic(this.platform.Characteristic.Mute).onGet(this.getMute.bind(this)).onSet(this.setMute.bind(this))

        // handle volume control
        speakerService.getCharacteristic(this.platform.Characteristic.VolumeSelector).onSet(this.setVolume.bind(this));

        return;
    }

    async createInputSourceServices() {
        this.state.inputs.forEach(async (input, i) => {
            try {
                const inputService = this.accessory.addService(this.platform.Service.InputSource, input.text, input.id);

                inputService
                    .setCharacteristic(this.platform.Characteristic.Identifier, i)
                    .setCharacteristic(this.platform.Characteristic.Name, input.text)
                    .setCharacteristic(this.platform.Characteristic.ConfiguredName, input.text)
                    .setCharacteristic(
                        this.platform.Characteristic.IsConfigured,
                        this.platform.Characteristic.IsConfigured.CONFIGURED,
                    )
                    .setCharacteristic(
                        this.platform.Characteristic.CurrentVisibilityState,
                        this.platform.Characteristic.CurrentVisibilityState.SHOWN,
                    )
                    .setCharacteristic(
                        this.platform.Characteristic.InputSourceType,
                        this.platform.Characteristic.InputSourceType.APPLICATION,
                    )
                    .setCharacteristic(
                        this.platform.Characteristic.InputDeviceType,
                        this.platform.Characteristic.InputDeviceType.TV,
                    );

                // Update input name cache
                inputService
                    .getCharacteristic(this.platform.Characteristic.ConfiguredName)
                    .onGet(async (): Promise<CharacteristicValue> => {
                        return input.text;
                    })
                    .onSet((name: CharacteristicValue) => {
                        const currentConfiguredName = inputService.getCharacteristic(
                            this.platform.Characteristic.ConfiguredName,
                        ).value;

                        if (name === currentConfiguredName) {
                            return;
                        }

                        this.platform.log.debug(`Set input (${input.id}) name to ${name} `);

                        const configuredName = name || input.text;

                        inputService.updateCharacteristic(this.platform.Characteristic.ConfiguredName, configuredName);
                    });

                // Update input visibility cache
                inputService
                    .getCharacteristic(this.platform.Characteristic.TargetVisibilityState)
                    .onGet(async (): Promise<CharacteristicValue> => {
                        return 0;
                    })
                    .onSet((targetVisibilityState: CharacteristicValue) => {
                        const currentVisbility = inputService.getCharacteristic(
                            this.platform.Characteristic.CurrentVisibilityState,
                        ).value;

                        if (targetVisibilityState === currentVisbility) {
                            return;
                        }

                        const isHidden = targetVisibilityState === this.platform.Characteristic.TargetVisibilityState.HIDDEN;

                        this.platform.log.debug(`Set input (${input.id}) visibility state to ${isHidden ? 'HIDDEN' : 'SHOWN'} `);

                        inputService.updateCharacteristic(
                            this.platform.Characteristic.CurrentVisibilityState,
                            targetVisibilityState,
                        );
                    });

                inputService.getCharacteristic(this.platform.Characteristic.Name).onGet((): CharacteristicValue => input.text);


                this.service.addLinkedService(inputService);
                this.inputServices.push(inputService);


            } catch (err) {
                this.platform.log.error(`
          Failed to add input service ${input.id}:
          ${err}
        `);
            }
        });
    }

    async updateInputSources() {
        for (const input in INPUTS) {
            this.state.inputs.push(input as unknown as Input)
        }
    }

    async updateAVRState() {
        try {

            await this.controller.refresh();
            let power = this.controller.GetPowerState(this.zone);
            let source = this.controller.GetSource(this.zone);
            this.platform.log.debug(`AVR PING`, { power: power, input: source});

            this.service.updateCharacteristic(this.platform.Characteristic.Active, power as CharacteristicValue);

            this.service.updateCharacteristic(
                this.platform.Characteristic.ActiveIdentifier,
                this.state.inputs.findIndex((input) => input.id === source),
            );

            if (this.state.connectionError) {
                this.state.connectionError = false;
                this.platform.log.info(`Communication with Yamaha AVR at ${this.platform.config.ip} restored`);
            }
        } catch (error) {
            if (this.state.connectionError) {
                return;
            }

            this.state.connectionError = true;
            this.platform.log.error(`
        Cannot communicate with Yamaha AVR at ${this.platform.config.ip}.
        Connection will be restored automatically when the AVR begins responding.
      `);
        }
    }

    async getPowerState(): Promise<CharacteristicValue> {
        return this.controller.GetPowerState(this.zone) as CharacteristicValue;
    }

    async setPowerState(state: CharacteristicValue) {
        await this.controller.SetPowerState(this.zone, state as boolean);
    }

    async getMute(): Promise<CharacteristicValue> {
        return this.controller.GetMuteState(this.zone) as CharacteristicValue;
    }

    async setMute(state: CharacteristicValue) {
        await this.controller.SetMuteSate(this.zone, state as boolean);
    }
    // async setRemoteKey(remoteKey: CharacteristicValue) {
    //     try {
    //         const sendRemoteCode = async (remoteKey: MainZoneRemoteCode) => {
    //             const sendIrCodeResponse = await fetch(`${this.baseApiUrl}/system/sendIrCode?code=${remoteKey}`);
    //             const responseJson = (await sendIrCodeResponse.json()) as BaseResponse;

    //             if (responseJson.response_code !== 0) {
    //                 throw new Error('Failed to send ir code');
    //             }
    //         };

    //         const controlCursor = async (cursor: Cursor) => {
    //             const controlCursorResponse = await fetch(`${this.baseApiUrl}/${this.zone}/controlCursor?cursor=${cursor}`);
    //             const responseJson = (await controlCursorResponse.json()) as BaseResponse;
    //             if (responseJson.response_code !== 0) {
    //                 throw new Error('Failed to control cursor');
    //             }
    //         };

    //         switch (remoteKey) {
    //             case this.platform.Characteristic.RemoteKey.REWIND:
    //                 this.platform.log.info('set Remote Key Pressed: REWIND');
    //                 sendRemoteCode(MainZoneRemoteCode.SEARCH_BACK);
    //                 break;

    //             case this.platform.Characteristic.RemoteKey.FAST_FORWARD:
    //                 this.platform.log.info('set Remote Key Pressed: FAST_FORWARD');
    //                 sendRemoteCode(MainZoneRemoteCode.SEARCH_FWD);
    //                 break;

    //             case this.platform.Characteristic.RemoteKey.NEXT_TRACK:
    //                 this.platform.log.info('set Remote Key Pressed: NEXT_TRACK');
    //                 sendRemoteCode(MainZoneRemoteCode.SKIP_FWD);
    //                 break;

    //             case this.platform.Characteristic.RemoteKey.PREVIOUS_TRACK:
    //                 this.platform.log.info('set Remote Key Pressed: PREVIOUS_TRACK');
    //                 sendRemoteCode(MainZoneRemoteCode.SKIP_BACK);
    //                 break;

    //             case this.platform.Characteristic.RemoteKey.ARROW_UP:
    //                 this.platform.log.info('set Remote Key Pressed: ARROW_UP');
    //                 controlCursor('up');
    //                 break;

    //             case this.platform.Characteristic.RemoteKey.ARROW_DOWN:
    //                 this.platform.log.info('set Remote Key Pressed: ARROW_DOWN');
    //                 controlCursor('down');
    //                 break;

    //             case this.platform.Characteristic.RemoteKey.ARROW_LEFT:
    //                 this.platform.log.info('set Remote Key Pressed: ARROW_LEFT');
    //                 controlCursor('left');
    //                 break;

    //             case this.platform.Characteristic.RemoteKey.ARROW_RIGHT:
    //                 this.platform.log.info('set Remote Key Pressed: ARROW_RIGHT');
    //                 controlCursor('right');
    //                 break;

    //             case this.platform.Characteristic.RemoteKey.SELECT:
    //                 this.platform.log.info('set Remote Key Pressed: SELECT');
    //                 controlCursor('select');
    //                 break;

    //             case this.platform.Characteristic.RemoteKey.BACK:
    //                 this.platform.log.info('set Remote Key Pressed: BACK');
    //                 controlCursor('return');
    //                 break;

    //             case this.platform.Characteristic.RemoteKey.EXIT:
    //                 this.platform.log.info('set Remote Key Pressed: EXIT');
    //                 sendRemoteCode(MainZoneRemoteCode.TOP_MENU);
    //                 break;

    //             case this.platform.Characteristic.RemoteKey.PLAY_PAUSE:
    //                 this.platform.log.info('set Remote Key Pressed: PLAY_PAUSE');
    //                 if (this.state.isPlaying) {
    //                     sendRemoteCode(MainZoneRemoteCode.PAUSE);
    //                 } else {
    //                     sendRemoteCode(MainZoneRemoteCode.PLAY);
    //                 }

    //                 this.state.isPlaying = !this.state.isPlaying;

    //                 break;

    //             case this.platform.Characteristic.RemoteKey.INFORMATION:
    //                 this.platform.log.info('set Remote Key Pressed: INFORMATION');
    //                 // We'll use the info button to flick through inputs
    //                 sendRemoteCode(MainZoneRemoteCode.INPUT_FWD);
    //                 break;

    //             default:
    //                 this.platform.log.info('unhandled Remote Key Pressed');
    //                 break;
    //         }
    //     } catch (error) {
    //         this.platform.log.error((error as Error).message);
    //     }
    // }

    async setVolume(direction: CharacteristicValue) {
        try {
            const currentVolume = Number(this.controller.GetVolume(this.zone));
            const volumeStep = 5;


            if (direction === 0) {
                this.platform.log.info('Volume Up', currentVolume + volumeStep);
                await this.controller.SetVolume(this.zone, currentVolume + volumeStep)
            } else {
                this.platform.log.info('Volume Down', currentVolume - volumeStep);
                await this.controller.SetVolume(this.zone, currentVolume - volumeStep)
            }

        } catch (error) {
            this.platform.log.error((error as Error).message);
        }
    }

    async getInputState(): Promise<CharacteristicValue> {
        let source = this.controller.GetSource(this.zone);
        return this.state.inputs.findIndex((input) => input.id === source);
    }

    async setInputState(inputIndex: CharacteristicValue) {
        try {
            if (typeof inputIndex !== 'number') {
                return;
            }

            const setInputResponse = await this.controller.SetSource(this.zone, this.state.inputs[inputIndex]);

            this.platform.log.info(`Set input: ${this.state.inputs[inputIndex].id}`);
        } catch (error) {
            this.platform.log.error((error as Error).message);
        }
    }
}