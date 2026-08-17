export function optionMap(args) {
  const options = new Map();
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const separator = token.indexOf("=");
    if (separator > 2) {
      options.set(token.slice(2, separator), token.slice(separator + 1));
      continue;
    }
    const name = token.slice(2);
    if (args[index + 1] != null && !args[index + 1].startsWith("--")) options.set(name, args[++index]);
    else options.set(name, true);
  }
  return { options, positional };
}
