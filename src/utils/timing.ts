export function logModuleLoadTime(moduleName: string, startTime: number) {
  const endTime = performance.now();
  const loadTime = (endTime - startTime).toFixed(2);
  console.log(`${moduleName} module finished loading [${loadTime}ms]`);
}
