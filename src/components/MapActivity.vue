<template>
  <div>
    <div id="map" :style="mapStyle">
      <q-resize-observable @resize="onMapResized" />
    </div>
    <q-btn 
      id="map-panel-toggle"
      color="secondary"
      class="fixed"
      style="right: 18px; top: 60px"
      small
      round 
      icon="layers"
      @click="layout.toggleRight()" />
  </div>
</template>

<script>
import _ from 'lodash'
import L from 'leaflet'
import 'leaflet-timedimension/dist/leaflet.timedimension.src.js'
import 'leaflet-timedimension/dist/leaflet.timedimension.control.css'
import logger from 'loglevel'
import moment from 'moment'
import { Events, QWindowResizeObservable, QResizeObservable, dom, QBtn } from 'quasar'
import { weacast } from 'weacast-core/client'
import 'weacast-leaflet'
import { utils as kCoreUtils } from '@kalisio/kdk-core/client'
import { mixins as kCoreMixins } from '@kalisio/kdk-core/client'
import { mixins as kMapMixins } from '@kalisio/kdk-map/client'

const { offset } = dom

export default {
  name: 'k-map-activity',
  components: {
    QWindowResizeObservable,
    QResizeObservable,
    QBtn
  },
  mixins: [
    kCoreMixins.baseActivity,
    kMapMixins.geolocation,
    kMapMixins.map.baseMap,
    kMapMixins.map.geojsonLayers,
    kMapMixins.map.forecastLayers
  ],
  inject: ['layout'],
  computed: {
    mapStyle () {
      return 'width: 100%; height: 100%; fontWeight: normal; zIndex: 0; position: absolute'
    }
  },
  watch: {
    forecastModel: function (model) {
      _.forOwn(this.leafletLayers, layer => {
        if (layer instanceof L.weacast.ForecastLayer) layer.setForecastModel(model)
      })
    }
  },
  methods: {
    async refreshActivity () {
      this.clearActivity()
      // Title
      this.setTitle('Kano')
      // Retrive the layers
      this.layers = {}
      const layersService = this.$api.getService('layers')
      let response = await layersService.find()
      _.forEach(response.data, (layer) => {
        if (layer.leaflet) {
          layer['handler'] = (options) => this.onLayerTriggered(layer, options)
          this.addLayer(layer)
        }
      })
      // Retrieve the forecast models
      await this.setupWeacast()
      _.forEach(this.forecastModels, (model) => model['handler'] = () => this.onForecastModelSelected(model))
      // Setup the right pane
      this.setRightPanelContent('MapPanel', this.$data)
      this.layout.hideRight()
      // TimeLine
      this.setupTimeline()
      // FAB
      this.registerFabAction({
        name: 'toggle-fullscreen', label: this.$t('MapActivity.TOGGLE_FULLSCREEN'), icon: 'fullscreen', handler: this.onToggleFullscreen
      })
      this.registerFabAction({
        name: 'geolocate', label: this.$t('MapActivity.GEOLOCATE'), icon: 'location_searching', handler: this.onGeolocate
      })
    },
    createLeafletTimedWmsLayer (options) {
      // Check for valid type
      if (options.type !== 'tileLayer.wms') return
      const layerOptions = _.get(options, 'arguments[1]', {})
      let layer = this.createLeafletLayer(options)
      // Specific case of time dimension layer where we embed the underlying WMS layer
      if (layerOptions.timeDimension) {
        layer = this.createLeafletLayer({ type: 'timeDimension.layer.wms', arguments: [ layer, layerOptions.timeDimension ] })
      }
      return layer
    },
    getPointMarker (feature, latlng) {
      // ADS-B
      if (_.has(feature, 'properties.icao')) {
        return this.createMarkerFromStyle(latlng, {
          icon: {
            type: 'icon',
            options: {
              iconUrl: '/statics/paper-plane.png',
              iconSize: [32, 32],
              iconAnchor: [16, 32]
            }
          }
        })
      }
      // Téléray
      else if (_.has(feature, 'properties.irsnId')) {
        const valid = _.get(feature, 'properties.libelle')
        const icon = (valid === 'VA' ? 'info-circle' : (valid === 'NV' ? 'question-circle' : 'times-circle'))
        const color = (valid === 'VA' ? 'darkblue' : (valid === 'NV' ? 'orange' : 'dark'))
        return this.createMarkerFromStyle(latlng, {
          icon: {
            type: 'icon.fontAwesome',
            options: {
              iconClasses: 'fa fa-' + icon,
              markerColor: color,
              iconColor: '#FFF'
            }
          }
        })
      }
      return null
    },
    getFeatureStyle (feature) {
      return this.convertFromSimpleStyleSpec(feature.properties || {})
    },
    getFeaturePopup (feature, layer) {
      let popup = L.popup({ autoPan: false }, layer)
      const name = _.get(feature, 'properties.name', _.get(feature, 'properties.NomEntVigiCru', _.get(feature, 'properties.icao')))
      return popup.setContent(name)
    },
    getFeatureTooltip (feature, layer) {
      const level = _.get(feature, 'properties.NivSituVigiCruEnt')
      if (level > 1) {
        let tooltip = L.tooltip({ permanent: false }, layer)
        let content
        switch (level) {
          case 2:
            content = 'Risque de crue génératrice de débordements'
            break
          case 3:
            content = 'Risque de crue génératrice de débordements importants'
            break
          case 4:
            content = 'Risque de crue majeure'
            break
        }
        return tooltip.setContent('<b>' + content + '</b>')
      }
      const callsign = _.get(feature, 'properties.callsign')
      if (callsign) {
        let tooltip = L.tooltip({ permanent: true }, layer)
        return tooltip.setContent('<b>' + callsign + '</b>')
      }
      const value = _.get(feature, 'properties.value')
      if (value) {
        let tooltip = L.tooltip({ permanent: false }, layer)
        return tooltip.setContent('<b>' + value + ' nSv/h</b>')
      }
      return null
    },
    onPopupOpen (event) {
      const feature = _.get(event, 'layer.feature')
      if (!feature) return
    },
    onFeatureClicked (event) {
      const feature = _.get(event, 'target.feature')
      if (!feature) return
    },
    onMapResized (size) {
      // Avoid to refresh the layout when leaving the component
      if (this.observe) this.refreshMap()
    },
    onMapMoved () {
      this.bounds = this.map.getBounds()
      this.$store.set('bounds', [
        [this.bounds.getSouth(), this.bounds.getWest()],
        [this.bounds.getNorth(), this.bounds.getEast()]
      ])
    },
    onLayerTriggered (layer, options) {
      if (options.isVisible === true) {
        this.showLayer(layer.name)
      } else {
        this.hideLayer(layer.name)
      } 
    },
    onForecastModelSelected (model) {
      this.forecastModel = model
    },
    onToggleFullscreen () {
      this.map.toggleFullscreen()
    },
    onGeolocate () {
      this.updatePosition()
    },
    onCurrentTimeChanged (time) {
      this.weacastApi.setForecastTime(time)
    },
    refreshOnGeolocation () {
      const position = this.$store.get('user.position')
      this.center(position.longitude, position.latitude)
    },
    setupWeacast () {
      const config = this.$config('weacast')
      this.weacastApi = weacast(this.$config('weacast'))
      return this.weacastApi.authenticate(config.authentication)
      .then(_ => this.setupForecastModels())
      .catch(error => logger.error('Cannot initialize weacast API', error))
    },
    setupTimeline () {
      // FIXME: to be replaced by timeline component initialization
      let timeDimension = L.timeDimension({})
      L.control.timeDimension({
        timeDimension,
        position: 'bottomright',
        speedSlider: false,
        playButton: false,
        playerOptions: { minBufferReady: -1 } // This avoid preloading of next times
      }).addTo(this.map)
      const now = moment.utc().startOf('hour')
      let times = []
      for (let timeOffset = 0; timeOffset <= 24; timeOffset += 1) {
        times.push(now.clone().add({ hours: timeOffset }))
      }
      timeDimension.on('timeload', data => this.setCurrentTime(data.time))
      timeDimension.setAvailableTimes(times.map(time => time.format()), 'replace')
    }
  },
  created () {
    // Enable the observers in order to refresh the layout
    this.observe = true
    this.registerLeafletConstructor(this.createLeafletTimedWmsLayer)
  },
  mounted () {
    this.setupMap()
    // Add aa scale control
    L.control.scale().addTo(this.map)
    this.$on('current-time-changed', this.onCurrentTimeChanged)
    this.map.on('moveend', this.onMapMoved)
    if (this.$store.has('bounds')) {
      this.map.fitBounds(this.$store.get('bounds'))
    }
    // Setup event connections
    // this.$on('popupopen', this.onPopupOpen)
    this.$on('click', this.onFeatureClicked)
    this.$on('collection-refreshed', this.onCollectionRefreshed)
    Events.$on('user-position-changed', this.refreshOnGeolocation)
    if (this.$store.get('user.position')) this.refreshOnGeolocation()
  },
  beforeDestroy () {
    this.$off('current-time-changed', this.onCurrentTimeChanged)
    this.map.off('moveend', this.onMapMoved)
    // No need to refresh the layout when leaving the component
    this.observe = false
    //this.removeCollectionLayer('Actors')
    // Remove event connections
    // this.$off('popupopen', this.onPopupOpen)
    this.$off('click', this.onFeatureClicked)
    this.$off('collection-refreshed', this.onCollectionRefreshed)
    Events.$off('user-position-changed', this.refreshOnGeolocation)
  }
}
</script>