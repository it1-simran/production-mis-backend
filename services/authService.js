const jwt = require('jsonwebtoken');

class AuthService {
  constructor(secretKey) {
    this.secretKey = secretKey; // JWT secret key
  }

  // Method to create JWT token
  createToken(user) {
    return jwt.sign({ id: user.id, username: user.username }, this.secretKey, { expiresIn: '24h' });
  }
  verifyToken(token) {
    return new Promise((resolve, reject) => {
      jwt.verify(token, this.secretKey, (err, decoded) => {
        if (err) {
          return reject('Invalid or expired token');
        }
        resolve(decoded);
      });
    });
  }
}

module.exports = AuthService;
