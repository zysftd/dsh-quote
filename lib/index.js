// dsh-quote host half: pure web client UI plugin, no host-side behavior.
// The empty apply exists so the plugin row mounts in the host cordis.yml;
// the browser half ships via exports["./client"] (package.json dsh.client).
export function apply() {}
