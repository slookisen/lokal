// Fixture for the module-cache block in tests/test.ts: bound to whichever
// factory copy was in require.cache when this module loaded, like a store
// bound to db-factory.
import { token } from "./factory";

export const factoryToken = token;
