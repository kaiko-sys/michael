create schema if not exists binaryusers ;

CREATE TABLE binaryusers.users (
    
    email VARCHAR(255) NOT NULL UNIQUE,

    phone_number VARCHAR(20) NOT NULL UNIQUE,

    password      TEXT NOT NULL,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);


select* from binaryusers.users;


