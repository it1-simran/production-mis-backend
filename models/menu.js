const mongoose = require("mongoose");

const menuSchema = new mongoose.Schema({
  menus: [
    {
      icon: { type: String, required: true },
      label: { type: String, required: true },
      route: { type: String, required: true },
      children: {
        type: [
          {
            label: { type: String, required: true },
            route: { type: String, required: true },
          },
        ],
        default: [],
      },
    },
  ],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

menuSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

const Menu = mongoose.model("Menu", menuSchema);

module.exports = Menu;
