## [1.0.0] - 2026-10-10

### First Rollout

- Added the Release Geolibre 
- Configured the Nginx to map inside

## [1.0.1] - 2026-10-13

### Application Automatic Tests

- Added the Unit Test inside the application
- Added e2e Tests

## [1.1.0] - 2026-10-14

### AOA Button 

- Added an AOA Button to zoom into the interested zone

## [1.1.1] - 2026-10-14

### Time Slider and Swipe Comparison

- Time slider: Added to the active layer card, with play/pause, forward/backward stepping, and playback speed from 0.5× to 4×. GeoServer TIME intervals are expanded into discrete dates, up to 2,000; non-expandable values remain editable as free text.
- Swipe comparison: Added a toolbar tool with synchronized side-by-side maps, supporting two layers or two dates of the same layer. The divider supports mouse and arrow-key controls. Other tools, 3D, and export are disabled during comparison.
- Time series: Added a toolbar tool that runs GetFeatureInfo for each selected layer date, with up to 60 requests and 6 concurrent requests. Larger date sets are sampled uniformly, with a notice. Missing values break chart lines. CSV download is supported.
- Styles and legend: Added a style selector for layers with multiple styles, with the selected style preserved in shared links. The map legend is always visible, collapsible, and refreshed when the style changes. Comparison mode displays legends for both layers.
- Permissions: Added `series` and `compare` permissions to roles, enabled by default for the viewer role.

## [1.2.0] - 2026-10-15

### Search, Basemaps, Layer Info and Saved Views

- Place and attribute search: Added a header search box. Places come from Nominatim (default, on Enter) or Photon (while typing), through the same-origin `/geocode/` nginx proxy, which has a rate limit, a one-day cache and no user credentials. Vector layers are searched with a CQL `ILIKE` over up to 8 text fields, plus numeric equality. Env: `GEOCODER` (`nominatim`, `photon`, `off`), `GEOCODER_URL`, `GEOCODER_COUNTRY`, `GEOCODER_LANG`, `GEOCODER_USER_AGENT`.
- Basemap switcher: OSM, satellite, dark and none. The list can be customised with `BASEMAPS` (`id|Label|tiles|attribution;…`). The choice is kept in the share link and used by the swipe comparison.
- Layer info sheet: Description, keywords, attribution, source link, bounding box with zoom, object count, geometry and attributes, taken from GetCapabilities, WFS and DescribeFeatureType.
- Saved views: Named bookmarks with layers, opacity, filters, date, style, basemap and camera, stored per user in the PostGIS table `saved_views` (WFS-T, Keycloak token), with a browser-only fallback when access control is off.
- Permissions: Added `search` and `views` tools, enabled by default for the viewer role. Existing role rules must be updated by an admin.
- Job `mapp-config-init`: Separate admin and application database users, `saved_views` table, `UPDATE_DATASTORE`, datastore diagnostics and clearer HTTP errors on publishing.
- Fix: nginx now serves the MapLibre worker (`.mjs`) with a JavaScript MIME type even when `mime.types` does not know it.

## [1.2.1] - 2026-10-15

### Fixes

- Time series: the value chosen in the selector could be overwritten by the default one when picked right after the data arrived; the shown value is now derived while rendering.
- Search: with Nominatim (search on Enter) the results of the previous text stayed listed while typing a new one; they are now cleared, and a search still in flight for the old text is discarded.

