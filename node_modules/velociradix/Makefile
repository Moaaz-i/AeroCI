CXX = clang++
CXXFLAGS = -std=c++17 -O3 -Wall -Wextra -pthread -I src -fPIC
LDFLAGS = -pthread

SRC_DIR = src
OBJ_DIR = obj
BIN_DIR = bin
TEST_DIR = tests

NODE_INC = deps/node-v22.19.0/include/node

UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
ADDON_LDFLAGS = -undefined dynamic_lookup
else
ADDON_LDFLAGS =
endif

LIB = $(BIN_DIR)/libvelociradix.a
SERVER = $(BIN_DIR)/velociradix_server
TEST_BIN = $(BIN_DIR)/velociradix_test
ADDON = $(BIN_DIR)/velociradix.node

LIB_OBJECTS = $(OBJ_DIR)/velociradix.o
SERVER_OBJECT = $(OBJ_DIR)/main.o
TEST_OBJECT = $(OBJ_DIR)/test.o

all: $(SERVER) $(ADDON)

$(LIB): $(LIB_OBJECTS)
	@mkdir -p $(BIN_DIR)
	ar rcs $@ $^

$(SERVER): $(LIB) $(SERVER_OBJECT)
	$(CXX) $(CXXFLAGS) -o $@ $(SERVER_OBJECT) $(LIB) $(LDFLAGS)

$(TEST_BIN): $(LIB) $(TEST_OBJECT)
	$(CXX) $(CXXFLAGS) -o $@ $(TEST_OBJECT) $(LIB) $(LDFLAGS)

$(OBJ_DIR)/%.o: $(SRC_DIR)/%.cpp
	@mkdir -p $(OBJ_DIR)
	$(CXX) $(CXXFLAGS) -c -o $@ $<

$(OBJ_DIR)/%.o: $(TEST_DIR)/%.cpp
	@mkdir -p $(OBJ_DIR)
	$(CXX) $(CXXFLAGS) -c -o $@ $<

$(OBJ_DIR)/addon.o: $(SRC_DIR)/addon.cpp
	@mkdir -p $(OBJ_DIR)
	$(CXX) $(CXXFLAGS) -I $(NODE_INC) -fPIC -c -o $@ $(SRC_DIR)/addon.cpp

$(ADDON): $(LIB) $(OBJ_DIR)/addon.o
	@mkdir -p $(BIN_DIR)
	$(CXX) $(CXXFLAGS) -I $(NODE_INC) -shared -fPIC $(ADDON_LDFLAGS) -o $@ $(OBJ_DIR)/addon.o $(LIB) $(LDFLAGS)

test: $(TEST_BIN)
	./$(TEST_BIN)

bench: $(ADDON)
	node bench/bench-addon.mjs 4

addon: $(ADDON)

clean:
	rm -rf $(OBJ_DIR) $(BIN_DIR)

.PHONY: all clean test bench addon
