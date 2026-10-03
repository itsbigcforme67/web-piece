// Added by web-piece (not part of piece-emu): what a "throw" becomes in a build without C++ exceptions.
#pragma once
#include <string>
[[noreturn]] void piece_fatal(const std::string& message);
