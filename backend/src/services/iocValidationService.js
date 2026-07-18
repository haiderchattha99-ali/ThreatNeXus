function detectIOCType({ ip, domain, hash }) {

    ip = (ip || "").trim();
    domain = (domain || "").trim();
    hash = (hash || "").trim();

    if (ip.length > 0) {
        if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
            return "IPv4";
        }

        if (ip.includes(":")) {
            return "IPv6";
        }
    }

    if (domain.length > 0) {
        return "Domain";
    }

    if (hash.length === 32) {
        return "MD5";
    }

    if (hash.length === 40) {
        return "SHA1";
    }

    if (hash.length === 64) {
        return "SHA256";
    }

    return "Unknown";
}

module.exports = {
    detectIOCType,
};