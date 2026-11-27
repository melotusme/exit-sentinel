export interface MapLinkSet {
  amap: string;
  google: string;
  osm: string;
}

export function mapLinks(latitude: number, longitude: number, name: string): MapLinkSet | null {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return null;
  }

  // IP & Nominatim coordinates use WGS84; explicitly declare wgs84 for Amap (whose default is GCJ-02).
  const amap = new URL('https://uri.amap.com/marker');
  amap.search = new URLSearchParams({
    position: `${longitude},${latitude}`,
    name: name || `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
    coordinate: 'wgs84',
    callnative: '0',
    src: 'ExitSentinel',
  }).toString();

  const google = new URL('https://www.google.com/maps/search/');
  google.search = new URLSearchParams({
    api: '1',
    query: `${latitude},${longitude}`,
  }).toString();

  const latFixed = latitude.toFixed(5);
  const lonFixed = longitude.toFixed(5);
  const osm = `https://www.openstreetmap.org/?mlat=${latFixed}&mlon=${lonFixed}#map=14/${latFixed}/${lonFixed}`;

  return {
    amap: amap.href,
    google: google.href,
    osm,
  };
}
