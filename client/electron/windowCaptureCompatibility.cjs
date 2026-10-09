const WGC_WINDOW_FEATURE = 'AllowWgcWindowCapturer';
const WINDOWS_10_WGC_MIN_BUILD = 17763;
const WINDOWS_11_MIN_BUILD = 22000;

function supportsWindows10WindowCaptureCompatibility(systemVersion) {
  const match = /^10\.0\.(\d+)$/.exec(String(systemVersion || ''));
  if (!match) return false;
  const build = Number(match[1]);
  return Number.isInteger(build) && build >= WINDOWS_10_WGC_MIN_BUILD && build < WINDOWS_11_MIN_BUILD;
}

function addDisabledFeature(disabledFeatures, featureName) {
  const features = new Set(String(disabledFeatures || '').split(',').map((feature) => feature.trim()).filter(Boolean));
  features.add(featureName);
  return [...features].join(',');
}

function removeFeatureFromSwitchArgs(args, switchName, featureName) {
  const prefix = '--' + switchName;
  const result = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = String(args[index]);
    let value;
    let consumedNext = false;

    if (argument === prefix) {
      const nextArgument = args[index + 1];
      if (nextArgument === undefined || String(nextArgument).startsWith('--')) {
        result.push(args[index]);
        continue;
      }
      value = nextArgument;
      consumedNext = true;
    } else if (argument.startsWith(prefix + '=')) {
      value = argument.slice(prefix.length + 1);
    } else {
      result.push(args[index]);
      continue;
    }

    const remaining = String(value)
      .split(',')
      .map((feature) => feature.trim())
      .filter((feature) => feature && feature !== featureName);

    if (remaining.length) {
      const filteredValue = remaining.join(',');
      result.push(consumedNext ? prefix : prefix + '=' + filteredValue);
      if (consumedNext) result.push(filteredValue);
    }
    if (consumedNext) index += 1;
  }

  return result;
}

module.exports = {
  WGC_WINDOW_FEATURE,
  addDisabledFeature,
  removeFeatureFromSwitchArgs,
  supportsWindows10WindowCaptureCompatibility,
};
