export function mapLinks(latitude: number, longitude: number, name: string) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude)>90 || Math.abs(longitude)>180) return null;
  // The databases use WGS84. Explicitly tell Amap, whose default is GCJ-02.
  const amap = new URL('https://uri.amap.com/marker');
  amap.search = new URLSearchParams({position:`${longitude},${latitude}`,name,coordinate:'wgs84',callnative:'0',src:'ExitSentinel'}).toString();
  const google = new URL('https://www.google.com/maps/search/');
  google.search = new URLSearchParams({api:'1',query:`${latitude},${longitude}`}).toString();
  return {amap:amap.href,google:google.href};
}
