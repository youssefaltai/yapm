import { builder } from "./builder.js";
import "./types.js";
import "./queries.js";
import "./mutations.js";

export type { GraphQLContext } from "./builder.js";

export const schema = builder.toSchema();
