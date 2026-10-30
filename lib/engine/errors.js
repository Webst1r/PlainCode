'use strict';

/**
 * A problem with the USER's code (e.g. a syntax error), as opposed to a server
 * fault. The server shows these messages to the user (HTTP 422) and refunds the run.
 */
class EngineError extends Error {
  constructor(message) {
    super(message);
    this.userFacing = true;
  }
}

module.exports = { EngineError };
