// db.js
const mongoose = require('mongoose');
const dns = require('dns');

// Some Windows setups expose only a link-local IPv6 resolver (e.g. fe80::1)
// that refuses Node's c-ares SRV queries, breaking mongodb+srv:// lookups even
// though the OS resolver works. Prepend reliable public resolvers so Atlas SRV
// records can always be resolved, while keeping the system resolvers as fallback.
const ensureDnsResolvers = () => {
    try {
        const existing = dns.getServers();
        const publicResolvers = ['8.8.8.8', '1.1.1.1'];
        const merged = [
            ...publicResolvers,
            ...existing.filter((server) => !publicResolvers.includes(server)),
        ];
        dns.setServers(merged);
    } catch (err) {
        console.warn('Could not adjust DNS resolvers:', err.message);
    }
};

const connectDB = async () => {
    try {
        ensureDnsResolvers();
        await mongoose.connect(process.env.MONGODB_URI, {
            autoIndex: true,
        });
        console.log('Connected !!');
    } catch (err) {
        console.error('Error connecting to MongoDB:', err.message);
        process.exit(1);  // Exit the process with failure
    }
};

module.exports = connectDB;
