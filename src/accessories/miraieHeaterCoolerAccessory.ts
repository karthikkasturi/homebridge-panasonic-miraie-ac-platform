import {CharacteristicValue, HAPStatus, PlatformAccessory, Service} from 'homebridge';
import PanasonicMirAIePlatform from '../platform/panasonicMiraiePlatform';
import {
    CommandType,
    FanSpeed,
    MirAIePlatformDeviceConnectionStatus,
    MirAIePlatformDeviceStatus,
    Mode,
    PanasonicMirAIeAccessoryContext
} from '../model/types';
import MirAIeBroker from "../broker/miraieBroker";
import MirAIePlatformLogger from "../utilities/logger";

/**
 * An instance of this class is created for each accessory the platform registers.
 * Each accessory may expose multiple services of different service types.
 */
export default class MirAIeHeaterCoolerAccessory {
    private service: Service;
    private displayService: Service | undefined;
    private onlineStatus: boolean = true;
    private log: MirAIePlatformLogger;

    constructor(
        private readonly platform: PanasonicMirAIePlatform,
        private readonly accessory: PlatformAccessory<PanasonicMirAIeAccessoryContext>,
        private readonly miraieBroker: MirAIeBroker,
    ) {
        this.log = this.platform.log;
        this.log.error("Begin constructor for MirAIeHeaterCoolerAccessory");
        // Accessory Information
        // https://developers.homebridge.io/#/service/AccessoryInformation
        this.accessory.getService(this.platform.Service.AccessoryInformation)
            ?.setCharacteristic(
                this.platform.Characteristic.Manufacturer,
                'Panasonic',
            )
            .setCharacteristic(
                this.platform.Characteristic.Model,
                // TODO - improvement: Fetch this detail from MirAIe platform
                'Unknown'
            )
            .setCharacteristic(
                this.platform.Characteristic.SerialNumber,
                // TODO - improvement: Fetch this detail from MirAIe platform
                'Unknown'
            );

        // Heater Cooler
        // https://developers.homebridge.io/#/service/HeaterCooler
        this.service = this.accessory.getService(this.platform.Service.HeaterCooler)
            || this.accessory.addService(this.platform.Service.HeaterCooler);

        // Characteristics configuration
        // Each service must implement at-minimum the "required characteristics"
        // See https://developers.homebridge.io/#/service/HeaterCooler

        // Name (optional)
        // This is what is displayed as the default name on the Home app
        this.service.setCharacteristic(
            this.platform.Characteristic.Name,
            accessory.context.deviceDisplayName || 'Unnamed',
        );

        // Active (required)
        this.service
            .getCharacteristic(this.platform.Characteristic.Active)
            .onSet(this.setActive.bind(this));

        // Current Temperature (required)
        this.service
            .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
            .setProps({
                minValue: -100,
                maxValue: 100,
                minStep: 0.5,
            });

        // Current Heater-Cooler State (required, but doesn't require a setter)

        // Target Heater-Cooler State (required)
        this.service
            .getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
            .onSet(this.setTargetHeaterCoolerState.bind(this));

        // Rotation Speed (optional)
        this.service
            .getCharacteristic(this.platform.Characteristic.RotationSpeed)
            .setProps({
                minValue: 0,
                maxValue: 100,
                minStep: 20,
            })
            .onSet(this.setRotationSpeed.bind(this));

        // Swing Mode (optional)
        this.service
            .getCharacteristic(this.platform.Characteristic.SwingMode)
            .onSet(this.setSwingMode.bind(this));

        // Cooling Threshold Temperature (optional)
        this.service
            .getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
            .setProps({
                minValue: 16,
                maxValue: 30,
                minStep: 0.5,
            })
            .onSet(this.setThresholdTemperature.bind(this));

        // Heating Threshold Temperature (optional)
        this.service
            .getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
            .setProps({
                minValue: 16,
                maxValue: 30,
                minStep: 0.5,
            })
            .onSet(this.setThresholdTemperature.bind(this));

        // Temperature Display Units (optional)
        this.service
            .setCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits,
                this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS);

        this.setupDisplayService();
        this.log.error("Done setting up display characteristic");

        // Subscribe to device's MirAIe MQTT status topics for continuous device updates
        // instead of using onGet handlers
        const statusTopics: string[] = this.accessory.context.device.topic.map(topic => `${topic}/status`);
        const connectionStatusTopics: string[] =
            this.accessory.context.device.topic.map(topic => `${topic}/connectionStatus`);
        this.miraieBroker.subscribe(statusTopics, this.refreshDeviceStatus.bind(this));
        this.miraieBroker.subscribe(connectionStatusTopics, this.refreshDeviceConnectionStatus.bind(this));
    }

    // In your constructor, after setting up the HeaterCooler service
    private setupDisplayService() {
        this.log.error("Setting up separate Switch service for display control");
        
        // Create a Switch service for display control
        const displayService = this.accessory.getService('AC Display') || 
            this.accessory.addService(this.platform.Service.Switch, 'AC Display', 'ac-display');
        
        // Set up the switch characteristic
        displayService.getCharacteristic(this.platform.Characteristic.On)
            .onSet(this.setDisplayMode.bind(this))
            .onGet(this.getDisplayMode.bind(this));
        
        // Store reference for updates
        this.displayService = displayService;
        
        this.log.error("AC Display switch service created successfully");
    }


    /**
     * Updates the device's connection status with as per the {@param deviceConnectionStatus}
     * @param deviceConnectionStatus Latest connection status of the device
     */
    public refreshDeviceConnectionStatus(deviceConnectionStatus: MirAIePlatformDeviceConnectionStatus): void {
        if (deviceConnectionStatus.onlineStatus === "true") {
            this.log.debug(`Device ['${this.accessory.displayName}'] is online, updating device status`);
            this.onlineStatus = true;
        } else {
            // Setting status as not responding if device is offline
            this.log.info(`Device ['${this.accessory.displayName}'] is offline,` +
                'setting status as not responding');
            this.onlineStatus = false;
            this.service.updateCharacteristic(this.platform.Characteristic.Active,
                new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE))
        }
    }

    /**
     * Updates the device's status with that of {@param deviceStatus}
     * @param deviceStatus Latest status of the device
     */
    public refreshDeviceStatus(deviceStatus: MirAIePlatformDeviceStatus): void {
        try {
            // Skipping refresh
            if (!this.onlineStatus) {
                this.log.debug(`Device ['${this.accessory.displayName}'] is offline,` +
                    'skipping device status refresh');
                return;
            }

            this.log.debug(`Refreshing device ['${this.accessory.displayName}'] details`);
            // Active
            if (deviceStatus.ps) {
                const active = deviceStatus.ps === "on"
                    ? this.platform.Characteristic.Active.ACTIVE
                    : this.platform.Characteristic.Active.INACTIVE;
                this.service.updateCharacteristic(this.platform.Characteristic.Active, active);
            }

            // Current Temperature
            if (deviceStatus.rmtmp) {
                this.service.updateCharacteristic(
                    this.platform.Characteristic.CurrentTemperature,
                    parseFloat(deviceStatus.rmtmp),
                );
            }

            // Current Heater-Cooler State and Target Heater-Cooler State
            const currentTemperature = this.service.getCharacteristic(
                this.platform.Characteristic.CurrentTemperature).value as number;
            const setTemperature = parseFloat(deviceStatus.actmp);

            switch (deviceStatus.acmd) {
                // Auto
                case "auto":
                    // Set target state and current state (based on current temperature)
                    this.service.updateCharacteristic(
                        this.platform.Characteristic.TargetHeaterCoolerState,
                        this.platform.Characteristic.TargetHeaterCoolerState.AUTO,
                    );

                    if (currentTemperature < setTemperature) {
                        this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
                            .updateValue(this.platform.Characteristic.CurrentHeaterCoolerState.HEATING);
                    } else if (currentTemperature > setTemperature) {
                        this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
                            .updateValue(this.platform.Characteristic.CurrentHeaterCoolerState.COOLING);
                    } else {
                        this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
                            .updateValue(this.platform.Characteristic.CurrentHeaterCoolerState.IDLE);
                    }
                    break;

                // Cool
                case "cool":
                    this.service.updateCharacteristic(
                        this.platform.Characteristic.TargetHeaterCoolerState,
                        this.platform.Characteristic.TargetHeaterCoolerState.COOL,
                    );

                    if (currentTemperature > setTemperature) {
                        this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
                            .updateValue(this.platform.Characteristic.CurrentHeaterCoolerState.COOLING);
                    } else {
                        this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
                            .updateValue(this.platform.Characteristic.CurrentHeaterCoolerState.IDLE);
                    }
                    break;

                // Dry (Dehumidifier)
                case "dry":
                    // TODO - improvement: Can we reflect this better/properly in Homebridge?
                    // Could add a https://developers.homebridge.io/#/service/HumidifierDehumidifier service
                    // to the accessory, but need to check what this implies for the UI.
                    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
                        .updateValue(this.platform.Characteristic.CurrentHeaterCoolerState.IDLE);
                    this.service.updateCharacteristic(
                        this.platform.Characteristic.TargetHeaterCoolerState,
                        this.platform.Characteristic.TargetHeaterCoolerState.HEAT,
                    );
                    break;

                // Fan
                case "fan":
                    // TODO - improvement: Same as above, related to:
                    // https://developers.homebridge.io/#/service/Fan
                    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
                        .updateValue(this.platform.Characteristic.CurrentHeaterCoolerState.IDLE);
                    this.service.updateCharacteristic(
                        this.platform.Characteristic.TargetHeaterCoolerState,
                        this.platform.Characteristic.TargetHeaterCoolerState.AUTO,
                    );
                    break;

                default:
                    this.log.error(`Unknown TargetHeaterCoolerState state: '${deviceStatus.acmd}'`);
                    break;
            }


            // Rotation Speed (optional)
            const fanSpeed = this.fanSpeedToPercentage(deviceStatus.acfs);
            if (fanSpeed != null) {
                this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
                    .updateValue(fanSpeed);
            }

            // Swing Mode (optional)
            if (deviceStatus.acvs === 0) {
                this.service.getCharacteristic(this.platform.Characteristic.SwingMode)
                    .updateValue(this.platform.Characteristic.SwingMode.SWING_ENABLED);
            } else {
                this.service.getCharacteristic(this.platform.Characteristic.SwingMode)
                    .updateValue(this.platform.Characteristic.SwingMode.SWING_DISABLED);
            }

            // Cooling Threshold Temperature (optional)
            // Heating Threshold Temperature (optional)
            this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
                .updateValue(setTemperature);
            this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
                .updateValue(setTemperature);

            if (deviceStatus.acdc && this.displayService) {
                this.displayService.updateCharacteristic(
                    this.platform.Characteristic.On,
                    deviceStatus.acdc === "on"
                );
            }
        } catch (error) {
            this.log.error('An error occurred while refreshing the device status. ' +
                'Turn on debug mode for more information.');

            // Only log if a Promise rejection reason was provided.
            // Some errors are already logged at source.
            if (error) {
                this.log.debug(JSON.stringify(error));
            }
        }
    }

    /**
     * Handle 'SET' requests from HomeKit
     * These are sent when the user changes the state of an accessory,
     * for example, turning on a Light bulb.
     */
    private async setActive(value: CharacteristicValue) {
        this.validateDeviceConnectionStatus();
        const command = value === this.platform.Characteristic.Active.ACTIVE ? "on" : "off";
        this.sendDeviceUpdate(this.accessory.context.device.topic[0], command, CommandType.POWER);
    }

    private async setDisplayMode(value: CharacteristicValue): Promise<void> {
        this.validateDeviceConnectionStatus();

        this.displayService?.updateCharacteristic(this.platform.Characteristic.On, value);

        // Send the command to the device
        this.sendDeviceUpdate(this.accessory.context.device.topic[0], value ? "on" : "off", CommandType.DISPLAY_MODE);

    }

    private async getDisplayMode(): Promise<CharacteristicValue> {
        this.validateDeviceConnectionStatus();        
        // Return the current value from the characteristic
        const currentValue = this.displayService?.getCharacteristic(this.platform.Characteristic.On).value;
        return currentValue || false;
    }

    private async setTargetHeaterCoolerState(value: CharacteristicValue) {
        this.validateDeviceConnectionStatus();
        let modeCommand;
        switch (value) {
            case this.platform.Characteristic.TargetHeaterCoolerState.AUTO:
                modeCommand = Mode.AUTO;
                break;

            case this.platform.Characteristic.TargetHeaterCoolerState.COOL:
                modeCommand = Mode.COOL;
                break;

            case this.platform.Characteristic.TargetHeaterCoolerState.HEAT:
                modeCommand = Mode.DRY;
                break;

            default:
                this.log.error(`Unknown TargetHeaterCoolerState [${value}]`);
                return;
        }

        this.sendDeviceUpdate(this.accessory.context.device.topic[0], modeCommand, CommandType.MODE);
    }

    private async setRotationSpeed(value: CharacteristicValue) {
        this.validateDeviceConnectionStatus();
        const fanSpeed = this.percentageToFanSpeed(value as number);

        if (fanSpeed != null) {
            this.sendDeviceUpdate(this.accessory.context.device.topic[0], fanSpeed.toString(), CommandType.FAN);
        }
    }

    private async setSwingMode(value: CharacteristicValue) {
        this.validateDeviceConnectionStatus();
        const command = value === this.platform.Characteristic.SwingMode.SWING_ENABLED ? 0 : 5

        this.sendDeviceUpdate(this.accessory.context.device.topic[0], command.toString(), CommandType.SWING);
    }

    private async setThresholdTemperature(value: CharacteristicValue) {
        this.validateDeviceConnectionStatus();
        /**
         * This function is used for Cooling AND Heating Threshold Temperature,
         * which is fine in HEAT and COOL mode. But in AUTO mode, it results in a conflict
         * because HomeKit allows setting a lower and an upper temperature but the remote control
         * and MirAIe platform app only set the target temperature.
         *
         * Option 1: Don't map the AUTO setting in HomeKit to AUTO on MirAIe platform,
         * but switch to COOL or HEAT on MirAIe platform depending on the current room temperature.
         * In that case, we could process the heating and cooling threshold accordingly.
         * Caveat: HomeKit set to AUTO would show up as HEAT or COOL in the MirAIe app, i.e.
         * we would produce an inconsistent state across control interfaces.
         *
         * Option 2: Map AUTO in HomeKit to AUTO on MirAIe platform and set the temperature which was set last
         * as target temperature. The user would have to drag both sliders close to each other
         * and treat it as one bar.
         * Caveat: We cannot replace a range slider in HomeKit by a single value. Any user
         * who doesn't read this note might be confused about this.
         *
         * Current choice is option 2 because the only implication for the user is wrongly set
         * temperature in the worst case. Option 1 would offer full functionality, but decrease
         * the compatibility with the Comfort Cloud app.
         */
        this.sendDeviceUpdate(this.accessory.context.device.topic[0], (value as number).toFixed(1), CommandType.TEMPERATURE);
    }

    /**
     * Throws HapStatusError if device is offline.
     */
    private validateDeviceConnectionStatus() {
        if (!this.onlineStatus) {
            this.log.info("Device is offline, unable to update device characteristic value");
            throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    private async sendDeviceUpdate(deviceTopic: string, command: string, cmdType: CommandType) {
        try {
            this.miraieBroker.publish(deviceTopic, command, cmdType);
        } catch (error) {
            this.log.error('An error occurred while sending a device update. ' +
                'Turn on debug mode for more information.');

            // Only log if a Promise rejection reason was provided.
            // Some errors are already logged at source.
            if (error) {
                this.log.debug(JSON.stringify(error));
            }
        }
    }

    private fanSpeedToPercentage(fanSpeed: string): number | null {
        switch (fanSpeed) {
            case "auto":
                return 20;
            case "quiet":
                return 40;
            case "low":
                return 60;
            case "medium":
                return 80;
            case "high":
                return 100;
            default:
                this.log.error(`Unknown FanSpeed string [${fanSpeed}]`)
        }
        return null;
    }

    private percentageToFanSpeed(percentage: number): FanSpeed | null {
        if (percentage <= 20) {
            return FanSpeed.AUTO;
        } else if (percentage <= 40) {
            return FanSpeed.QUIET;
        } else if (percentage <= 60) {
            return FanSpeed.LOW;
        } else if (percentage <= 80) {
            return FanSpeed.MEDIUM;
        } else if (percentage == 100) {
            return FanSpeed.HIGH;
        }
        return null;
    }
}
