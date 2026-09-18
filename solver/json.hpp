#pragma once

/*
 * Minimal read-only JSON parser for FluidX3D Studio.
 *
 * Header-only, C++17, standard library only, no dependency on any FluidX3D
 * header. Everything lives in namespace json so it cannot collide with the
 * global `using std::string; using std::vector;` in utilities.hpp.
 *
 * Reading is total: every lookup that does not resolve returns a shared null
 * value, and every as_*() takes the fallback to use in that case. A setup can
 * therefore never crash on a missing or misspelled config entry.
 *
 *   json::Document doc = json::parse_file("config.json");
 *   if(!doc.ok()) { ... doc.error ... }
 *   const float size_x = doc.root["domain"]["size_m"][0].as_float(36.0f);
 */

#include <cstddef>
#include <fstream>
#include <locale>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace json {

namespace detail { struct Parser; }

class Value {
	friend struct detail::Parser;

public:
	enum class Kind { Null, Boolean, Number, String, Array, Object };

	Value() = default;

	Kind kind() const { return kind_; }
	bool is_null() const { return kind_==Kind::Null; }
	bool is_bool() const { return kind_==Kind::Boolean; }
	bool is_number() const { return kind_==Kind::Number; }
	bool is_string() const { return kind_==Kind::String; }
	bool is_array() const { return kind_==Kind::Array; }
	bool is_object() const { return kind_==Kind::Object; }

	/* A missing path and an explicit JSON null are deliberately the same thing
	   here: both mean "use the default". */
	bool exists() const { return kind_!=Kind::Null; }

	std::size_t size() const {
		if(kind_==Kind::Array) return array_.size();
		if(kind_==Kind::Object) return object_.size();
		return (std::size_t)0;
	}

	/* The shared empty value every failed lookup resolves to. */
	static const Value& none() {
		static const Value empty;
		return empty;
	}

	const Value& member(const std::string& key) const {
		if(kind_==Kind::Object) {
			for(std::size_t i=(std::size_t)0; i<object_.size(); i++) {
				if(object_[i].first==key) return object_[i].second;
			}
		}
		return none();
	}

	/* Element of an array, or the i-th member value of an object. */
	const Value& element(const std::size_t index) const {
		if(kind_==Kind::Array&&index<array_.size()) return array_[index];
		if(kind_==Kind::Object&&index<object_.size()) return object_[index].second;
		return none();
	}

	/* Name of the i-th object member; empty string for anything else. */
	const std::string& name_at(const std::size_t index) const {
		static const std::string empty;
		if(kind_==Kind::Object&&index<object_.size()) return object_[index].first;
		return empty;
	}

	const Value& operator[](const std::string& key) const { return member(key); }
	const Value& operator[](const char* key) const { return member(key==nullptr ? std::string() : std::string(key)); }
	const Value& operator[](const std::size_t index) const { return element(index); }
	// int overload keeps j[0] unambiguous against the const char* overload
	const Value& operator[](const int index) const { return index<0 ? none() : element((std::size_t)index); }

	double as_double(const double fallback) const {
		if(kind_==Kind::Number) return number_;
		if(kind_==Kind::Boolean) return boolean_ ? 1.0 : 0.0;
		if(kind_==Kind::String) { // tolerate numbers that were quoted
			double parsed = 0.0;
			if(string_to_double(string_, parsed)) return parsed;
		}
		return fallback;
	}
	float as_float(const float fallback) const { return (float)as_double((double)fallback); }

	long long as_llong(const long long fallback) const {
		const double value = as_double((double)fallback);
		return (long long)(value<0.0 ? value-0.5 : value+0.5);
	}
	int as_int(const int fallback) const { return (int)as_llong((long long)fallback); }
	unsigned int as_uint(const unsigned int fallback) const {
		const long long value = as_llong((long long)fallback);
		return value<0ll ? fallback : (unsigned int)value;
	}
	unsigned long long as_ullong(const unsigned long long fallback) const {
		const long long value = as_llong((long long)fallback);
		return value<0ll ? fallback : (unsigned long long)value;
	}

	bool as_bool(const bool fallback) const {
		if(kind_==Kind::Boolean) return boolean_;
		if(kind_==Kind::Number) return number_!=0.0;
		return fallback;
	}

	std::string as_string(const std::string& fallback) const {
		return kind_==Kind::String ? string_ : fallback;
	}

	/* Locale-independent number parsing; strtod() would follow LC_NUMERIC and
	   break on systems where the decimal separator is a comma. */
	static bool string_to_double(const std::string& text, double& out) {
		std::istringstream stream(text);
		stream.imbue(std::locale::classic());
		double value = 0.0;
		stream >> value;
		if(stream.fail()) return false;
		out = value;
		return true;
	}

private:
	Kind kind_ = Kind::Null;
	bool boolean_ = false;
	double number_ = 0.0;
	std::string string_;
	std::vector<Value> array_;
	std::vector<std::pair<std::string, Value>> object_;
};

struct Document {
	Value root;
	std::string error; // empty exactly when parsing succeeded

	bool ok() const { return error.empty(); }
	const Value& operator[](const std::string& key) const { return root.member(key); }
	const Value& operator[](const char* key) const { return root[key]; }
};

namespace detail {

inline void append_utf8(std::string& out, const unsigned int code) {
	if(code<0x80u) {
		out += (char)code;
	} else if(code<0x800u) {
		out += (char)(0xC0u|(code>>6));
		out += (char)(0x80u|(code&0x3Fu));
	} else if(code<0x10000u) {
		out += (char)(0xE0u|(code>>12));
		out += (char)(0x80u|((code>>6)&0x3Fu));
		out += (char)(0x80u|(code&0x3Fu));
	} else {
		out += (char)(0xF0u|(code>>18));
		out += (char)(0x80u|((code>>12)&0x3Fu));
		out += (char)(0x80u|((code>>6)&0x3Fu));
		out += (char)(0x80u|(code&0x3Fu));
	}
}

struct Parser {
	static const int max_depth = 64; // guards against stack exhaustion on hostile input

	const std::string& text;
	std::size_t pos = (std::size_t)0;
	std::string error;

	explicit Parser(const std::string& source) : text(source) {}

	bool fail(const std::string& message) {
		if(error.empty()) error = message;
		return false;
	}

	void skip_bom() {
		if(text.size()>=(std::size_t)3&&(unsigned char)text[0]==0xEFu&&(unsigned char)text[1]==0xBBu&&(unsigned char)text[2]==0xBFu) pos = (std::size_t)3;
	}

	void skip_whitespace() {
		while(pos<text.size()) {
			const char c = text[pos];
			if(c==' '||c=='\t'||c=='\n'||c=='\r') pos++;
			else break;
		}
	}

	bool literal(const char* word) {
		std::size_t i = (std::size_t)0;
		while(word[i]!='\0') {
			if(pos+i>=text.size()||text[pos+i]!=word[i]) return false;
			i++;
		}
		pos += i;
		return true;
	}

	bool parse_hex4(unsigned int& out) {
		if(pos+(std::size_t)4>text.size()) return fail("Incomplete \\u escape sequence.");
		unsigned int value = 0u;
		for(std::size_t i=(std::size_t)0; i<(std::size_t)4; i++) {
			const char c = text[pos+i];
			unsigned int digit = 0u;
			if(c>='0'&&c<='9') digit = (unsigned int)(c-'0');
			else if(c>='a'&&c<='f') digit = (unsigned int)(c-'a')+10u;
			else if(c>='A'&&c<='F') digit = (unsigned int)(c-'A')+10u;
			else return fail("Invalid digit in \\u escape sequence.");
			value = value*16u+digit;
		}
		pos += (std::size_t)4;
		out = value;
		return true;
	}

	bool parse_string(std::string& out) {
		if(pos>=text.size()||text[pos]!='"') return fail("String expected.");
		pos++;
		out.clear();
		while(true) {
			if(pos>=text.size()) return fail("Unterminated string.");
			const char c = text[pos];
			if(c=='"') { pos++; return true; }
			if(c!='\\') {
				if((unsigned char)c<0x20u) return fail("Control character in string.");
				out += c;
				pos++;
				continue;
			}
			pos++; // consume the backslash
			if(pos>=text.size()) return fail("Unterminated escape sequence.");
			const char escape = text[pos];
			pos++;
			switch(escape) {
				case '"' : out += '"' ; break;
				case '\\': out += '\\'; break;
				case '/' : out += '/' ; break;
				case 'b' : out += '\b'; break;
				case 'f' : out += '\f'; break;
				case 'n' : out += '\n'; break;
				case 'r' : out += '\r'; break;
				case 't' : out += '\t'; break;
				case 'u' : {
					unsigned int code = 0u;
					if(!parse_hex4(code)) return false;
					if(code>=0xD800u&&code<=0xDBFFu) { // high surrogate, expect the low half
						if(pos+(std::size_t)1<text.size()&&text[pos]=='\\'&&text[pos+(std::size_t)1]=='u') {
							const std::size_t saved = pos;
							pos += (std::size_t)2;
							unsigned int low = 0u;
							if(!parse_hex4(low)) return false;
							if(low>=0xDC00u&&low<=0xDFFFu) code = 0x10000u+((code-0xD800u)<<10)+(low-0xDC00u);
							else pos = saved; // not a pair after all; emit both separately
						}
					}
					append_utf8(out, code);
					break;
				}
				default: return fail("Unknown escape sequence.");
			}
		}
	}

	bool parse_number(Value& out) {
		const std::size_t start = pos;
		if(pos<text.size()&&(text[pos]=='-'||text[pos]=='+')) pos++;
		bool digits = false;
		while(pos<text.size()&&text[pos]>='0'&&text[pos]<='9') { pos++; digits = true; }
		if(pos<text.size()&&text[pos]=='.') {
			pos++;
			while(pos<text.size()&&text[pos]>='0'&&text[pos]<='9') { pos++; digits = true; }
		}
		if(!digits) return fail("Number expected.");
		if(pos<text.size()&&(text[pos]=='e'||text[pos]=='E')) {
			pos++;
			if(pos<text.size()&&(text[pos]=='-'||text[pos]=='+')) pos++;
			bool exponent_digits = false;
			while(pos<text.size()&&text[pos]>='0'&&text[pos]<='9') { pos++; exponent_digits = true; }
			if(!exponent_digits) return fail("Exponent without digits.");
		}
		double value = 0.0;
		if(!Value::string_to_double(text.substr(start, pos-start), value)) return fail("Could not read number.");
		out.kind_ = Value::Kind::Number;
		out.number_ = value;
		return true;
	}

	bool parse_array(Value& out, const int depth) {
		pos++; // consume '['
		out.kind_ = Value::Kind::Array;
		skip_whitespace();
		if(pos<text.size()&&text[pos]==']') { pos++; return true; }
		while(true) {
			Value element;
			if(!parse_value(element, depth+1)) return false;
			out.array_.push_back(std::move(element));
			skip_whitespace();
			if(pos>=text.size()) return fail("Unterminated array.");
			if(text[pos]==',') { pos++; continue; }
			if(text[pos]==']') { pos++; return true; }
			return fail("\",\" or \"]\" expected.");
		}
	}

	bool parse_object(Value& out, const int depth) {
		pos++; // consume '{'
		out.kind_ = Value::Kind::Object;
		skip_whitespace();
		if(pos<text.size()&&text[pos]=='}') { pos++; return true; }
		while(true) {
			skip_whitespace();
			std::string key;
			if(!parse_string(key)) return false;
			skip_whitespace();
			if(pos>=text.size()||text[pos]!=':') return fail("\":\" expected after key.");
			pos++;
			Value member;
			if(!parse_value(member, depth+1)) return false;
			out.object_.push_back(std::make_pair(key, std::move(member)));
			skip_whitespace();
			if(pos>=text.size()) return fail("Unterminated object.");
			if(text[pos]==',') { pos++; continue; }
			if(text[pos]=='}') { pos++; return true; }
			return fail("\",\" or \"}\" expected.");
		}
	}

	bool parse_value(Value& out, const int depth) {
		if(depth>max_depth) return fail("JSON is nested too deeply.");
		skip_whitespace();
		if(pos>=text.size()) return fail("Unexpected end of document.");
		const char c = text[pos];
		if(c=='{') return parse_object(out, depth);
		if(c=='[') return parse_array(out, depth);
		if(c=='"') {
			std::string value;
			if(!parse_string(value)) return false;
			out.kind_ = Value::Kind::String;
			out.string_ = std::move(value);
			return true;
		}
		if(c=='t') {
			if(!literal("true")) return fail("Invalid literal.");
			out.kind_ = Value::Kind::Boolean;
			out.boolean_ = true;
			return true;
		}
		if(c=='f') {
			if(!literal("false")) return fail("Invalid literal.");
			out.kind_ = Value::Kind::Boolean;
			out.boolean_ = false;
			return true;
		}
		if(c=='n') {
			if(!literal("null")) return fail("Invalid literal.");
			out.kind_ = Value::Kind::Null;
			return true;
		}
		return parse_number(out);
	}

	/* Human-readable position for error messages. */
	std::string location() const {
		std::size_t line = (std::size_t)1, column = (std::size_t)1;
		for(std::size_t i=(std::size_t)0; i<pos&&i<text.size(); i++) {
			if(text[i]=='\n') { line++; column = (std::size_t)1; } else column++;
		}
		return "line "+std::to_string((unsigned long long)line)+", column "+std::to_string((unsigned long long)column);
	}
};

} // namespace detail

inline Document parse(const std::string& source) {
	Document document;
	detail::Parser parser(source);
	parser.skip_bom();
	if(!parser.parse_value(document.root, 0)) {
		document.root = Value();
		document.error = parser.error+" ("+parser.location()+")";
		return document;
	}
	parser.skip_whitespace();
	if(parser.pos!=source.size()) {
		document.root = Value();
		document.error = "Characters after the end of the JSON document ("+parser.location()+").";
	}
	return document;
}

inline Document parse_file(const std::string& path) {
	Document document;
	std::ifstream file(path, std::ios::in|std::ios::binary);
	if(!file.good()) {
		document.error = "Could not open file \""+path+"\".";
		return document;
	}
	std::ostringstream buffer;
	buffer << file.rdbuf();
	file.close();
	const std::string source = buffer.str();
	if(source.empty()) {
		document.error = "File \""+path+"\" is empty.";
		return document;
	}
	return parse(source);
}

} // namespace json
