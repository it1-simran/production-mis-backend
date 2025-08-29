const User = require("../models/User");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";
class UserService {
  async authenticate(data) {
    const { email, password } = data;
    try {
      const user = await User.findOne({ email });
      if (!user) {
        return { status: 401, success: false, message: "Invalid credentials" };
      }
      const isPasswordMatch = await bcrypt.compare(password, user.password);
      if (!isPasswordMatch) {
        return {
          status: 401,
          success: false,
          message: "Password does not match",
        };
      }
      const token = jwt.sign({ id: user._id, email: user.email }, JWT_SECRET, {
        expiresIn: "1h",
      });

      return {
        status: 200,
        success: true,
        user: user,
        message: "Login successfully",
        token,
      };
    } catch (error) {
      return {
        status: 500,
        success: false,
        message: "Internal server error: " + error.message,
      };
    }
  }
  async register(data) {
    const { name, email, mobileNo, dateOfBirth, userType, department } = data;
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(data.password, salt);
    const password = hashedPassword;
    try {
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return { message: "User already exists : " + email };
      }
      const newUser = new User({
        name,
        email,
        mobileNo,
        password,
        dateOfBirth,
        userType,
        department,
      });
      const savedUser = await newUser.save();
      return { message: "User registered successfully", user: savedUser };
    } catch (error) {
      throw new Error(error.message || "Error registering user");
    }
  }
  async getPassword(data) {
    try {
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(data, saltRounds);

      res.status(200).json({ hashedPassword });
    } catch (error) {
      throw new Error(error.message || "Error registering user");
    }
  }
}

module.exports = UserService;
