const colorsys = require('colorsys')
const { Service, Characteristic } = require('../types')
const WyzeAccessory = require('./WyzeAccessory')

const WYZE_API_POWER_PROPERTY = 'P3'
const WYZE_API_BRIGHTNESS_PROPERTY = 'P1501'
const WYZE_API_COLOR_TEMP_PROPERTY = 'P1502'

const WYZE_COLOR_TEMP_MIN = 2700
const WYZE_COLOR_TEMP_MAX = 6500
const HOMEKIT_COLOR_TEMP_MIN = 500
const HOMEKIT_COLOR_TEMP_MAX = 140

const WYZE_API_COLOR_PROPERTY = 'P1507'

const noResponse = new Error('No Response')
noResponse.toString = () => { return noResponse.message }

module.exports = class WyzeMeshLight extends WyzeAccessory {
  constructor (plugin, homeKitAccessory) {
    super(plugin, homeKitAccessory)

    this.getCharacteristic(Characteristic.On).on('set', this.setOn.bind(this))
    this.getCharacteristic(Characteristic.Brightness).on('set', this.setBrightness.bind(this))
    this.getCharacteristic(Characteristic.ColorTemperature).on('set', this.setColorTemperature.bind(this))
    this.getCharacteristic(Characteristic.Hue).on('set', this.setHue.bind(this))
    this.getCharacteristic(Characteristic.Saturation).on('set', this.setSaturation.bind(this))

    // Local caching of HSV color space handling separate Hue & Saturation on HomeKit
    // Caching idea for handling HSV colors from:
    //    https://github.com/QuickSander/homebridge-http-rgb-push/blob/master/index.js
    this.cache = {}
    this.cacheUpdated = false
  }

  async updateCharacteristics (device) {
    if (device.conn_state === 0) {
      this.getCharacteristic(Characteristic.On).updateValue(noResponse)
    } else {
      this.getCharacteristic(Characteristic.On).updateValue(device.device_params.switch_state)

      const propertyList = await this.getPropertyList()
      for (const property of propertyList.data.property_list) {
        switch (property.pid) {
          case WYZE_API_BRIGHTNESS_PROPERTY:
            this.updateBrightness(property.value)
            break

          case WYZE_API_COLOR_TEMP_PROPERTY:
            this.updateColorTemp(property.value)
            break

          case WYZE_API_COLOR_PROPERTY:
            this.updateColor(property.value)
            break
        }
      }
    }
  }

  updateBrightness (value) {
    if(this.plugin.config.logging == "debug") this.plugin.log(`Updating brightness record for ${this.homeKitAccessory.context.mac} (${this.homeKitAccessory.context.nickname}) to ${value}: ${JSON.stringify(value)}`)
    this.getCharacteristic(Characteristic.Brightness).updateValue(value)
  }

  updateColorTemp (value) {
    if(this.plugin.config.logging == "debug") this.plugin.log(`Updating color Temp record for ${this.homeKitAccessory.context.mac} (${this.homeKitAccessory.context.nickname}) to ${value}: ${JSON.stringify(this._kelvinToMired(value))}`)
    this.getCharacteristic(Characteristic.ColorTemperature).updateValue(this._kelvinToMired(value))
  }

  updateColor (value) {
    // Convert a Hex color from Wyze into the HSL values recognized by HomeKit.
    const hslValue = colorsys.hex2Hsv(value)
    if(this.plugin.config.logging == "debug") this.plugin.log(`Updating color record for ${this.homeKitAccessory.context.mac} (${this.homeKitAccessory.context.nickname}) to ${value}: ${JSON.stringify(hslValue)}`)

    // Update Hue
    this.updateHue(hslValue.h)
    this.cache.hue = hslValue.h

    // Update Saturation
    this.updateSaturation(hslValue.s)
    this.cache.saturation = hslValue.s
  }

  updateHue (value) {
    this.getCharacteristic(Characteristic.Hue).updateValue(value)
  }

  updateSaturation (value) {
    this.getCharacteristic(Characteristic.Saturation).updateValue(value)
  }

  getService () {
    let service = this.homeKitAccessory.getService(Service.Lightbulb)

    if (!service) {
      service = this.homeKitAccessory.addService(Service.Lightbulb)
    }

    return service
  }

  getCharacteristic (characteristic) {
    return this.getService().getCharacteristic(characteristic)
  }

  sleep (ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  async setOn (value, callback) {
    if(this.plugin.config.logging == "debug") this.plugin.log(`Setting power for ${this.homeKitAccessory.context.mac} (${this.homeKitAccessory.context.nickname}) to ${value}`)

    try {
      await this.runActionList(WYZE_API_POWER_PROPERTY, (value) ? 1 : 0)
      callback()
    } catch (e) {
      callback(e)
    }
  }

  async setBrightness (value, callback) {
    await this.sleep(250)
    if(this.plugin.config.logging == "debug") this.plugin.log(`Setting brightness for ${this.homeKitAccessory.context.mac} (${this.homeKitAccessory.context.nickname}) to ${value}`)

    try {
      await this.runActionList(WYZE_API_BRIGHTNESS_PROPERTY, value)
      callback()
    } catch (e) {
      callback(e)
    }
  }

  async setColorTemperature (value, callback) {
    await this.sleep(500)
    const floatValue = this._rangeToFloat(value, HOMEKIT_COLOR_TEMP_MIN, HOMEKIT_COLOR_TEMP_MAX)
    const wyzeValue = this._floatToRange(floatValue, WYZE_COLOR_TEMP_MIN, WYZE_COLOR_TEMP_MAX)

    if(this.plugin.config.logging == "debug") this.plugin.log(`Setting color temperature for ${this.homeKitAccessory.context.mac} (${this.homeKitAccessory.context.nickname}) to ${value} (${wyzeValue})`)

    try {
      await this.runActionList(WYZE_API_COLOR_TEMP_PROPERTY, wyzeValue)
      callback()
    } catch (e) {
      callback(e)
    }
  }

  async setHue (value, callback) {
    await this.sleep(750)
    if(this.plugin.config.logging == "debug") this.plugin.log(`Setting hue (color) for ${this.homeKitAccessory.context.mac} (${this.homeKitAccessory.context.nickname}) to ${value}`)
    if(this.plugin.config.logging == "debug") this.plugin.log(`(H)S Values: ${value}, ${this.cache.saturation}`)

    try {
      this.cache.hue = value
      if (this.cacheUpdated) {
        let hexValue = colorsys.hsv2Hex(this.cache.hue, this.cache.saturation, 100)
        hexValue = hexValue.replace('#', '')
        if(this.plugin.config.logging == "debug") this.plugin.log(hexValue)

        await this.runActionList(WYZE_API_COLOR_PROPERTY, hexValue)
        this.cacheUpdated = false
      } else {
        this.cacheUpdated = true
      }
      callback()
    } catch (e) {
      callback(e)
    }
  }

  async setSaturation (value, callback) {
    await this.sleep(1000)
    if(this.plugin.config.logging == "debug") this.plugin.log(`Setting saturation (color) for ${this.homeKitAccessory.context.mac} (${this.homeKitAccessory.context.nickname}) to ${value}`)
    if(this.plugin.config.logging == "debug") this.plugin.log(`H(S) Values: ${this.cache.saturation}, ${value}`)

    try {
      this.cache.saturation = value
      if (this.cacheUpdated) {
        let hexValue = colorsys.hsv2Hex(this.cache.hue, this.cache.saturation, 100)
        hexValue = hexValue.replace('#', '')
        await this.runActionList(WYZE_API_COLOR_PROPERTY, hexValue)
        this.cacheUpdated = false
      } else {
        this.cacheUpdated = true
      }
      callback()
    } catch (e) {
      callback(e)
    }
  }

  _rangeToFloat (value, min, max) {
    return (value - min) / (max - min)
  }

  _floatToRange (value, min, max) {
    return Math.round((value * (max - min)) + min)
  }

  _kelvinToMired (value) {
    return Math.round(1000000 / value)
  }
}
