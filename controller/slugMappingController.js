const SlugMapping = require("../models/slugMapping");

// Default slug↔PO-field mappings, seeded once when the collection is empty.
const DEFAULT_SLUGS = [
  { slug: "vendor_id", label: "Vendor ID", source: "vendorId" },
  { slug: "esim_make", label: "eSIM Make", source: "esim.make" },
  { slug: "esim_profile", label: "eSIM Profile", source: "esim.profile1" },
  { slug: "pip", label: "PIP", source: "configuration.values.pip.value" },
  { slug: "eip", label: "EIP", source: "configuration.values.eip.value" },
  { slug: "gip_port", label: "GIP Port", source: "configuration.values.gip_port.value" },
];

module.exports = {
  create: async (req, res) => {
    try {
      const { id, slug, label, source, isActive } = req.body;
      const cleanSlug = String(slug || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
      if (!cleanSlug || !String(source || "").trim()) {
        return res.status(400).json({ status: 400, message: "Slug and Source (PO field) are required." });
      }
      const data = { slug: cleanSlug, label: label || "", source: String(source).trim(), isActive: isActive !== false, updatedAt: Date.now() };

      if (id) {
        const updated = await SlugMapping.findByIdAndUpdate(id, data, { new: true });
        if (!updated) return res.status(404).json({ status: 404, message: "Slug not found" });
        return res.status(200).json({ status: 200, message: "Slug updated", data: updated });
      }
      const created = await new SlugMapping(data).save();
      return res.status(200).json({ status: 200, message: "Slug created", data: created });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({ status: 409, message: "That slug already exists." });
      }
      console.error("slugMapping create error:", error);
      return res.status(500).json({ status: 500, message: "Server error", error: error.message });
    }
  },

  view: async (req, res) => {
    try {
      // Lazy-seed the defaults the first time the page is opened.
      if ((await SlugMapping.estimatedDocumentCount()) === 0) {
        await SlugMapping.insertMany(DEFAULT_SLUGS.map((s) => ({ ...s })));
      }
      const data = await SlugMapping.find().sort({ slug: 1 }).lean();
      return res.status(200).json({ status: 200, data });
    } catch (error) {
      console.error("slugMapping view error:", error);
      return res.status(500).json({ status: 500, message: "Server error", error: error.message });
    }
  },

  delete: async (req, res) => {
    try {
      await SlugMapping.findByIdAndDelete(req.params.id);
      return res.status(200).json({ status: 200, message: "Slug deleted" });
    } catch (error) {
      console.error("slugMapping delete error:", error);
      return res.status(500).json({ status: 500, message: "Server error", error: error.message });
    }
  },
};
