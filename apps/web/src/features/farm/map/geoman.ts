import type {} from '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import L from 'leaflet';
// The package's exports map only names the unminified build, so this addresses the file by path.
import geomanUrl from '../../../../node_modules/@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.min.js?url';

let loading: Promise<void> | undefined;

/**
 * Geoman is a plain script that uses a global `L` and imports nothing, so a bundler cannot see that
 * it depends on Leaflet and may run it first: "L is not defined", in production builds only.
 * Loading it as a script after Leaflet makes the order explicit. Resolves before any map is created,
 * because Geoman attaches `map.pm` through an init hook.
 */
export function loadGeoman(): Promise<void> {
  loading ??= new Promise<void>((resolve, reject) => {
    (window as unknown as { L: typeof L }).L = L;
    const script = document.createElement('script');
    script.src = geomanUrl;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = undefined;
      reject(new Error('Map drawing tools failed to load'));
    };
    document.head.append(script);
  });
  return loading;
}
