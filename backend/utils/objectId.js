const mongoose = require("mongoose");

const assertObjectId = (id, label = "ID") => {
  if (!mongoose.isValidObjectId(id)) {
    const err = new Error(`Invalid ${label}: ${id}`);
    err.statusCode = 400;
    err.code = "ERR_INVALID_ID";
    throw err;
  }
};

module.exports = { assertObjectId };
