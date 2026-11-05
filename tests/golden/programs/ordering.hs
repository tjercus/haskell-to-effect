module Main where

data Size = Small | Medium | Large deriving (Show, Eq, Ord)

main :: IO ()
main = do
  print ("apple" < "banana", "abc" == "abc", 'a' < 'b')
  print (max "pear" "fig", min [3, 1] [2, 5])
  print (Just 3 > Nothing, Left 1 < (Right 0 :: Either Int Int))
  print (Small < Large, max Medium Small, [Small, Large] /= [Small, Large])
  print ((1, 'b') < (1, 'c'), (2, 'a') > (1, 'z'))
